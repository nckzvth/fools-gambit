import { Application } from "pixi.js";

// Basic Pixi canvas attached to #stage
const host = document.getElementById("stage");
if (!host) throw new Error("Missing #stage element");

const app = new Application();

await app.init({
  resizeTo: host,
  antialias: true,
  backgroundAlpha: 0,
});

host.appendChild(app.canvas);

// Minimal placeholder so you know it's running
const g = app.stage.addChild(new (await import("pixi.js")).Graphics());
g.rect(40, 40, 300, 180).stroke({ width: 2, color: 0xffffff });
g.moveTo(40, 40).lineTo(340, 220);
