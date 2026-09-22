// Canvas particle + floating-text effects, extracted from main.ts (Phase 2
// refactor, Increment 2). Pure functions over explicit state arrays — no class,
// no `this` — so the orchestrator keeps owning the arrays and just delegates.
// (DOM confetti and cameraShake/highlightPulse stay in the orchestrator.)

export interface Particle {
  x: number;
  y: number;
  color: string;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
}

export interface FloatingText {
  text: string;
  x: number;
  y: number;
  color: string;
  size: number;
  vy: number;
  life: number;
  maxLife: number;
}

// Anim #4: Arrow projectile — flies from archer to target
export interface ArrowProjectile {
  x: number; // current canvas x
  y: number; // current canvas y
  sx: number; // start x
  sy: number; // start y
  tx: number; // target x
  ty: number; // target y
  progress: number; // 0→1
  color: string;
  angle: number; // radians, pointing at target
}

export function createParticle(
  particles: Particle[],
  x: number,
  y: number,
  color: string,
  vx = 0,
  vy = -2,
  life = 30,
): void {
  particles.push({ x, y, color, vx, vy, life, maxLife: life, size: 3 });
}

export function createExplosion(
  particles: Particle[],
  x: number,
  y: number,
  color: string,
  count = 8,
): void {
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count;
    const speed = 1.5 + Math.random() * 1.5;
    createParticle(
      particles,
      x,
      y,
      color,
      Math.cos(angle) * speed,
      Math.sin(angle) * speed,
      15 + Math.random() * 15,
    );
  }
}

export function createFloatingText(
  texts: FloatingText[],
  text: string,
  x: number,
  y: number,
  color = '#fff',
  size = 16,
): void {
  texts.push({ text, x, y, color, size, vy: -1.4, life: 55, maxLife: 55 });
}

// Anim #4: create an arrow projectile flying from (sx,sy) to (tx,ty)
export function createArrow(
  arrows: ArrowProjectile[],
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  color = '#ffe066',
): void {
  const angle = Math.atan2(ty - sy, tx - sx);
  arrows.push({ x: sx, y: sy, sx, sy, tx, ty, progress: 0, color, angle });
}

/** Advance particle physics and drop dead ones. Returns the surviving array. */
export function updateParticles(particles: Particle[]): Particle[] {
  return particles.filter((p) => {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.05;
    p.life--;
    return p.life > 0;
  });
}

/** Advance floating-text rise and drop expired ones. Returns survivors. */
export function updateFloatingTexts(texts: FloatingText[]): FloatingText[] {
  return texts.filter((t) => {
    t.y += t.vy;
    t.life--;
    return t.life > 0;
  });
}

/** Advance arrow projectiles (speed: reaches target in ~10 frames). Returns survivors. */
export function updateArrows(arrows: ArrowProjectile[]): ArrowProjectile[] {
  return arrows.filter((a) => {
    a.progress += 0.11;
    if (a.progress >= 1) return false;
    const t = a.progress;
    // Ease-out for crisp arrival
    const e = 1 - (1 - t) * (1 - t);
    // Slight arc — peak at midpoint
    const arc = Math.sin(t * Math.PI) * 12;
    const perpX = -Math.sin(a.angle);
    const perpY = Math.cos(a.angle);
    a.x = a.sx + (a.tx - a.sx) * e + perpX * arc;
    a.y = a.sy + (a.ty - a.sy) * e + perpY * arc;
    return true;
  });
}

export function drawParticles(ctx: CanvasRenderingContext2D, particles: Particle[]): void {
  particles.forEach((p) => {
    const alpha = p.life / p.maxLife;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}

export function drawFloatingTexts(ctx: CanvasRenderingContext2D, texts: FloatingText[]): void {
  texts.forEach((t) => {
    const alpha = t.life / t.maxLife;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = t.color;
    ctx.font = `bold ${t.size}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.strokeText(t.text, t.x, t.y);
    ctx.fillText(t.text, t.x, t.y);
  });
  ctx.globalAlpha = 1;
}

/** Anim #4: draw arrows as thin angled lines with a triangular head. */
export function drawArrows(ctx: CanvasRenderingContext2D, arrows: ArrowProjectile[]): void {
  arrows.forEach((a) => {
    const alpha = 1 - a.progress * 0.4;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(a.x, a.y);
    ctx.rotate(a.angle);
    // shaft
    ctx.strokeStyle = a.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-10, 0);
    ctx.lineTo(5, 0);
    ctx.stroke();
    // head
    ctx.fillStyle = a.color;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(2, -3);
    ctx.lineTo(2, 3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  });
}
