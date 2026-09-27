import { chromium } from "playwright-core";
import { existsSync } from "node:fs";

const candidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const executablePath = candidates.find(existsSync);
if (!executablePath) throw new Error("Set CHROME_PATH to a Chromium executable before running this smoke test.");

const baseURL = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

try {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  const host = await context.newPage();
  const viewer = await context.newPage();
  const secondViewer = await context.newPage();
  await host.goto(`${baseURL}/host`);
  await host.getByRole("button", { name: "Camera" }).click();
  await host.getByText("Source ready").waitFor();
  await host.getByRole("button", { name: "Create room" }).click();
  await host.getByRole("button", { name: "Creating room…" }).waitFor();
  await host.waitForFunction(() => {
    const value = document.querySelector(".room-card strong")?.textContent ?? "";
    return value.length === 6 && !value.includes("—");
  });
  const code = (await host.locator(".room-card strong").textContent())?.trim();
  if (!code || code.includes("—")) throw new Error("Host did not create a room code.");

  await viewer.goto(`${baseURL}/viewer`);
  await viewer.getByPlaceholder("ABC234").fill(code);
  await viewer.getByRole("button", { name: "Join stream" }).click();
  await viewer.getByText("Live", { exact: true }).waitFor({ timeout: 20_000 });
  await host.locator(".status-dot.connected").waitFor({ timeout: 20_000 });
  await viewer.waitForFunction(() => {
    const video = document.querySelector("video");
    return video?.srcObject instanceof MediaStream && video.srcObject.getVideoTracks().length > 0 && video.readyState >= 2;
  }, undefined, { timeout: 20_000 });

  await secondViewer.goto(`${baseURL}/viewer`);
  await secondViewer.getByPlaceholder("ABC234").fill(code);
  await secondViewer.getByRole("button", { name: "Join stream" }).click();
  await secondViewer.getByText("Live", { exact: true }).waitFor({ timeout: 20_000 });

  // Reloading must release the old participant even though Leave was not used.
  await viewer.reload();
  await viewer.waitForTimeout(750);
  await viewer.getByPlaceholder("ABC234").fill(code);
  await viewer.getByRole("button", { name: "Join stream" }).click();
  await viewer.getByText("Live", { exact: true }).waitFor({ timeout: 20_000 });

  await host.getByRole("button", { name: "End room" }).click();
  await viewer.getByRole("heading", { name: "The server ended the stream" }).waitFor({ timeout: 10_000 });
  await secondViewer.getByRole("heading", { name: "The server ended the stream" }).waitFor({ timeout: 10_000 });
  await viewer.getByRole("button", { name: "Back to client page" }).click();
  await viewer.getByRole("button", { name: "Join stream" }).waitFor();
  console.log(`WebRTC smoke test passed for room ${code}.`);
} finally {
  await browser.close();
}
