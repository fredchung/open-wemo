import { existsSync, unlinkSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { closeDatabase, getAppDataDir, getDatabase } from "./db";
import { handleAutoInstall } from "./install";
import { type ServerInstance, getLocalIpAddress, startServer } from "./server";
import { getSavedAutostartPreference, setAutostart, syncAutostart } from "./tray/autostart";
import { type AppTray, createTray } from "./tray/index";
import {
  MenuItemIds,
  createMenuClickHandler,
  createMenuItems,
  getServerUrl,
  openInBrowser,
} from "./tray/menu";
import { getPreferredIp } from "./tray/qr-window";
import { shouldShowWelcome } from "./tray/welcome";
import { discoverDevices } from "./wemo/discovery";
import { startKeepAlive } from "./wemo/keepalive";
import { loadDeviceRules, startScheduler } from "./wemo/scheduler";

/** Default server port (51515 chosen to avoid conflicts with common dev servers) */
const DEFAULT_PORT = 51515;
const DEFAULT_HOST = "0.0.0.0";

/** Application state */
interface AppState {
  server: ServerInstance | null;
  tray: AppTray | null;
  isShuttingDown: boolean;
  startOnLogin: boolean;
  scheduler: { stop: () => void } | null;
  keepAlive: { stop: () => void } | null;
  isHeadless: boolean;
  port: number;
  host: string;
}

const state: AppState = {
  server: null,
  tray: null,
  isShuttingDown: false,
  startOnLogin: false,
  scheduler: null,
  keepAlive: null,
  isHeadless: false,
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
};

/**
 * Checks if the port is available.
 */
async function isPortAvailable(port: number, host = "0.0.0.0"): Promise<boolean> {
  try {
    const server = Bun.serve({
      port,
      hostname: host,
      fetch: () => new Response("test"),
    });
    server.stop();
    return true;
  } catch {
    return false;
  }
}

/**
 * Initializes the application.
 */
async function initialize(): Promise<void> {
  console.log("[Main] Open Wemo Bridge starting...");
  console.log(`[Main] Platform: ${platform()} (${process.arch})`);
  console.log(`[Main] Node version: ${process.version}`);
  console.log(`[Main] Bun version: ${Bun.version}`);
  if (state.isHeadless) {
    console.log("[Main] Mode: Headless (system tray and browser popups disabled)");
  }

  // Check if port is available
  const portAvailable = await isPortAvailable(state.port, state.host);
  if (!portAvailable) {
    console.error(`[Main] Port ${state.port} is already in use!`);
    console.error("[Main] Another instance of Open Wemo may be running.");
    console.error("[Main] Please close it or specify another port with --port <number>.");

    // Try to show a notification on supported desktop platforms
    if (!state.isHeadless && platform() === "darwin") {
      Bun.spawn([
        "osascript",
        "-e",
        `display notification "Port ${state.port} is already in use. Another instance may be running." with title "Open Wemo"`,
      ]);
    }

    process.exit(1);
  }

  // Step 1: Initialize database
  console.log("[Main] Initializing database...");
  try {
    const db = getDatabase();
    console.log(`[Main] Database initialized at: ${db.path}`);

    // Load saved preferences
    state.startOnLogin = getSavedAutostartPreference();
    console.log(`[Main] Auto-start on login: ${state.startOnLogin}`);

    // Sync auto-start setting with system (only in desktop mode)
    if (!state.isHeadless) {
      await syncAutostart();
    }
  } catch (error) {
    console.error("[Main] Failed to initialize database:", error);
    throw error;
  }

  // Step 2: Start HTTP server
  console.log("[Main] Starting HTTP server...");
  try {
    state.server = await startServer({ port: state.port, host: state.host });
    console.log(`[Main] Server running at ${state.server.url}`);
  } catch (error) {
    console.error("[Main] Failed to start server:", error);
    throw error;
  }

  // Step 3: Create system tray (skipped in headless mode)
  if (state.isHeadless) {
    console.log("[Main] Skipping system tray in headless mode");
  } else {
    console.log("[Main] Creating system tray...");
    try {
      await createSystemTray();
      console.log("[Main] System tray created");
    } catch (error) {
      console.error("[Main] Failed to create system tray:", error);
      // Continue anyway - tray is not critical
    }
  }

  // Step 4: Run initial device discovery (background)
  console.log("[Main] Running initial device discovery...");
  runBackgroundDiscovery();

  // Step 5: Start timer scheduler
  console.log("[Main] Starting timer scheduler...");
  state.scheduler = startScheduler();
  const devices = getDatabase().getAllDevices();
  for (const device of devices) {
    loadDeviceRules(device.id, device.host, device.port).catch(() => {});
  }
  console.log(`[Main] Timer scheduler started (${devices.length} devices loaded)`);

  // Step 6: Start keep-alive service for Insight devices with low-power loads
  state.keepAlive = startKeepAlive();

  const localUrl = `http://localhost:${state.port}`;
  const lanIp = getPreferredIp() || getLocalIpAddress();
  const lanUrl = lanIp ? `http://${lanIp}:${state.port}` : null;

  // Step 7: Show first-launch setup if needed
  if (shouldShowWelcome()) {
    if (state.isHeadless) {
      console.log("[Main] First launch detected!");
      console.log(`[Main] Configure devices at: ${lanUrl ? `${lanUrl}/setup` : `${localUrl}/setup`}`);
    } else {
      console.log("[Main] First launch detected, opening device setup page...");
      openInBrowser(`${localUrl}/setup`);
    }
  }

  console.log("[Main] Open Wemo Bridge is ready!");
  console.log(`[Main] Local URL:   ${localUrl}`);
  if (lanUrl) {
    console.log(`[Main] Network URL: ${lanUrl}`);
  }
}

/**
 * Creates the system tray with menu.
 */
async function createSystemTray(): Promise<void> {
  const menuItems = createMenuItems(state.startOnLogin);

  state.tray = createTray({
    tooltip: "Open Wemo - WeMo Device Controller",
    onReady: () => {
      console.log("[Main] Tray ready");
    },
    onExit: () => {
      console.log("[Main] Tray exit requested");
      shutdown();
    },
    onClick: createMenuClickHandler(
      {
        onOpenBrowser: () => {
          console.log("[Main] Opening browser...");
          openInBrowser(getServerUrl(DEFAULT_PORT));
        },
        onShowQR: () => {
          console.log("[Main] Opening QR code page...");
          openInBrowser(`${getServerUrl(DEFAULT_PORT)}/qr`);
        },
        onSetupDevice: () => {
          console.log("[Main] Opening device setup page...");
          openInBrowser(`${getServerUrl(DEFAULT_PORT)}/setup`);
        },
        onDiscover: async () => {
          console.log("[Main] Running device discovery...");
          await runBackgroundDiscovery();
        },
        onStartOnLoginToggle: async (enabled: boolean) => {
          console.log(`[Main] Toggling auto-start: ${enabled}`);
          state.startOnLogin = enabled;
          await setAutostart(enabled);

          // Update menu item checked state
          state.tray?.updateMenuItem(MenuItemIds.START_ON_LOGIN, { checked: enabled });
        },
        onQuit: () => {
          console.log("[Main] Quit requested from menu");
          shutdown();
        },
      },
      () => state.startOnLogin,
      (value) => {
        state.startOnLogin = value;
      }
    ),
  });

  await state.tray.create(menuItems);
}

/**
 * Runs device discovery in the background.
 */
async function runBackgroundDiscovery(): Promise<void> {
  try {
    const result = await discoverDevices({ timeout: 5000 });
    console.log(`[Main] Discovery found ${result.devices.length} device(s)`);

    // Save discovered devices to database
    const db = getDatabase();
    for (const device of result.devices) {
      const deviceId = device.serialNumber || `device-${Date.now()}`;

      // Check if device exists by ID (serial number) - handles IP changes after re-setup
      const existingById = db.getDeviceById(deviceId);
      if (existingById) {
        // Device exists - check if IP changed
        if (existingById.host !== device.host || existingById.port !== device.port) {
          console.log(
            `[Main] Device ${device.name} IP changed: ${existingById.host}:${existingById.port} -> ${device.host}:${device.port}`
          );
          // Update the device with new IP
          db.saveDevice({
            ...existingById,
            host: device.host,
            port: device.port,
            updatedAt: new Date().toISOString(),
          });
        } else {
          db.updateLastSeen(existingById.id);
        }
        continue;
      }

      // Check by host (for devices without serial numbers)
      const existingByHost = db.getDeviceByHost(device.host);
      if (existingByHost) {
        db.updateLastSeen(existingByHost.id);
        continue;
      }

      // New device - save it
      db.saveDevice({
        id: deviceId,
        name: device.name,
        deviceType: device.deviceType,
        host: device.host,
        port: device.port,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      console.log(`[Main] Saved new device: ${device.name}`);
    }
  } catch (error) {
    console.error("[Main] Discovery failed:", error);
  }
}

/**
 * Gracefully shuts down the application.
 */
async function shutdown(): Promise<void> {
  if (state.isShuttingDown) {
    console.log("[Main] Shutdown already in progress...");
    return;
  }

  state.isShuttingDown = true;
  console.log("[Main] Shutting down...");

  if (state.keepAlive) {
    state.keepAlive.stop();
    state.keepAlive = null;
  }

  if (state.scheduler) {
    state.scheduler.stop();
    state.scheduler = null;
    console.log("[Main] Timer scheduler stopped");
  }

  // Step 1: Stop HTTP server
  if (state.server) {
    try {
      await state.server.stop();
      console.log("[Main] Server stopped");
    } catch (error) {
      console.error("[Main] Error stopping server:", error);
    }
    state.server = null;
  }

  // Step 2: Destroy tray
  if (state.tray) {
    try {
      state.tray.destroy();
      console.log("[Main] Tray destroyed");
    } catch (error) {
      console.error("[Main] Error destroying tray:", error);
    }
    state.tray = null;
  }

  // Step 3: Close database
  try {
    closeDatabase();
    console.log("[Main] Database closed");
  } catch (error) {
    console.error("[Main] Error closing database:", error);
  }

  console.log("[Main] Shutdown complete");
  process.exit(0);
}

/**
 * Sets up global error handlers.
 */
function setupErrorHandlers(): void {
  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    console.error("[Main] Uncaught exception:", error);

    // Update tray to show error state if available
    if (state.tray) {
      state.tray.updateState("error");
    }

    // Don't crash - log and continue
  });

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason, promise) => {
    console.error("[Main] Unhandled rejection at:", promise, "reason:", reason);

    // Update tray to show error state if available
    if (state.tray) {
      state.tray.updateState("error");
    }

    // Don't crash - log and continue
  });

  // Handle graceful shutdown signals
  process.on("SIGINT", () => {
    console.log("[Main] Received SIGINT");
    shutdown();
  });

  process.on("SIGTERM", () => {
    console.log("[Main] Received SIGTERM");
    shutdown();
  });

  // Windows-specific: handle Ctrl+C
  if (platform() === "win32") {
    process.on("SIGHUP", () => {
      console.log("[Main] Received SIGHUP");
      shutdown();
    });
  }
}

// ==================== CLI Arguments ====================

export interface CliResult {
  shouldExit: boolean;
  headless: boolean;
  port: number;
  host: string;
  noInstall: boolean;
}

/**
 * Parse and handle CLI arguments.
 */
function parseCliArgs(): CliResult {
  const args = process.argv.slice(2);

  // --help
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Open Wemo Bridge

Usage: open-wemo [options]

Options:
  --help, -h              Show this help message
  --headless, -H          Run in headless mode (system tray and browser popups disabled)
  --port, -p <number>     Port to listen on (default: 51515, or PORT env)
  --host <address>        Host address to bind to (default: 0.0.0.0, or HOST env)
  --no-install            Run in place without auto-installing to ~/.local/bin or AppData
  --generate-service      Output a systemd service unit file for headless/Raspberry Pi setup
  --reset-first-launch    Reset first-launch flag (triggers setup wizard on next start)
  --reset-db              Delete database and start fresh (removes all devices and settings)
  --version, -v           Show version information
`);
    return { shouldExit: true, headless: false, port: DEFAULT_PORT, host: DEFAULT_HOST, noInstall: false };
  }

  // --version
  if (args.includes("--version") || args.includes("-v")) {
    console.log("Open Wemo Bridge v0.4.1");
    return { shouldExit: true, headless: false, port: DEFAULT_PORT, host: DEFAULT_HOST, noInstall: false };
  }

  // --generate-service
  if (args.includes("--generate-service")) {
    const isCompiled = import.meta.dir.includes("~BUN") || import.meta.dir.startsWith("$bunfs");
    const execPath = isCompiled ? process.execPath : "open-wemo";
    console.log(`[Unit]
Description=Open Wemo Bridge - WeMo Device Controller
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execPath} --headless
Restart=on-failure
RestartSec=5s
Environment=NODE_ENV=production

# Install as systemd service:
# User service:
#   mkdir -p ~/.config/systemd/user
#   open-wemo --generate-service > ~/.config/systemd/user/open-wemo.service
#   systemctl --user daemon-reload
#   systemctl --user enable --now open-wemo
# System service:
#   sudo open-wemo --generate-service > /etc/systemd/system/open-wemo.service
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now open-wemo

[Install]
WantedBy=default.target
`);
    return { shouldExit: true, headless: false, port: DEFAULT_PORT, host: DEFAULT_HOST, noInstall: false };
  }

  // --reset-first-launch
  if (args.includes("--reset-first-launch")) {
    console.log("[CLI] Resetting first-launch flag...");
    try {
      const db = getDatabase();
      db.setBoolSetting("first_launch_completed", false);
      db.setBoolSetting("dont_show_welcome", false);
      console.log("[CLI] First-launch flag reset. Setup wizard will show on next start.");
    } catch (error) {
      console.error("[CLI] Failed to reset flag:", error);
    }
    return { shouldExit: true, headless: false, port: DEFAULT_PORT, host: DEFAULT_HOST, noInstall: false };
  }

  // --reset-db
  if (args.includes("--reset-db")) {
    console.log("[CLI] Deleting database...");
    try {
      const dbPath = join(getAppDataDir(), "open-wemo.db");
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;

      // Delete main database file
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
        console.log(`[CLI] Deleted: ${dbPath}`);
      }
      // Delete WAL file if exists
      if (existsSync(walPath)) {
        unlinkSync(walPath);
        console.log(`[CLI] Deleted: ${walPath}`);
      }
      // Delete SHM file if exists
      if (existsSync(shmPath)) {
        unlinkSync(shmPath);
        console.log(`[CLI] Deleted: ${shmPath}`);
      }

      console.log("[CLI] Database reset complete. A fresh database will be created on next start.");
    } catch (error) {
      console.error("[CLI] Failed to delete database:", error);
    }
    return { shouldExit: true, headless: false, port: DEFAULT_PORT, host: DEFAULT_HOST, noInstall: false };
  }

  // Parse port
  let port = DEFAULT_PORT;
  if (process.env.PORT) {
    const envPort = Number.parseInt(process.env.PORT, 10);
    if (!Number.isNaN(envPort) && envPort > 0) port = envPort;
  }
  const portIdx = args.findIndex((arg) => arg === "--port" || arg === "-p");
  if (portIdx !== -1 && args[portIdx + 1]) {
    const parsedPort = Number.parseInt(args[portIdx + 1], 10);
    if (!Number.isNaN(parsedPort) && parsedPort > 0) {
      port = parsedPort;
    } else {
      console.warn(`[CLI] Invalid port '${args[portIdx + 1]}', using default: ${port}`);
    }
  }

  // Parse host
  let host = process.env.HOST || DEFAULT_HOST;
  const hostIdx = args.indexOf("--host");
  if (hostIdx !== -1 && args[hostIdx + 1]) {
    host = args[hostIdx + 1];
  }

  // Parse headless
  let headless = false;
  if (args.includes("--headless") || args.includes("-H")) {
    headless = true;
  } else if (process.env.HEADLESS === "1" || process.env.HEADLESS === "true") {
    headless = true;
  } else if (process.env.OPEN_WEMO_HEADLESS === "1" || process.env.OPEN_WEMO_HEADLESS === "true") {
    headless = true;
  } else if (platform() === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    // Auto-detect Linux headless environment (e.g. Raspberry Pi OS Lite, SSH session, systemd)
    headless = true;
  }

  // Parse no-install (default to true in headless mode so systemd / terminal runs are not backgrounded)
  const noInstall = args.includes("--no-install") || process.env.NO_AUTO_INSTALL === "1" || headless;

  return {
    shouldExit: false,
    headless,
    port,
    host,
    noInstall,
  };
}

// ==================== Application Entry ====================

// Handle CLI arguments first
const cliOptions = parseCliArgs();
if (cliOptions.shouldExit) {
  process.exit(0);
}

// Apply CLI options to application state
state.isHeadless = cliOptions.headless;
state.port = cliOptions.port;
state.host = cliOptions.host;

// Set up error handlers first
setupErrorHandlers();

// Handle auto-install (copies exe to AppData/bin and relaunches if needed)
// This must run before initialize() so the installed version takes over
if (!handleAutoInstall({ noInstall: cliOptions.noInstall })) {
  // Installed version was launched, exit this instance
  process.exit(0);
}

// Start the application
initialize().catch((error) => {
  console.error("[Main] Failed to initialize:", error);
  process.exit(1);
});
