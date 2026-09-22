// Small self-contained canvas shape helpers, extracted from main.ts (Phase 2
// refactor). Pure — take the 2D context explicitly, no class/`this`.

/** A toppled stone column used as a ruins decoration. */
export function drawBrokenColumn(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + w, y + 14);
  ctx.lineTo(x + w - 5, y + 8);
  ctx.lineTo(x + w - 10, y + 12);
  ctx.lineTo(x + w - 13, y + 7);
  ctx.lineTo(x + 5, y + 10);
  ctx.lineTo(x + 2, y + 6);
  ctx.lineTo(x, y + 14);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(x + 2, y + 16, w - 4, h - 18);
}
