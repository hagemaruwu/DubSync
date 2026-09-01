/**
 * generate-icons.js
 * Generates extension icons at 16, 48, and 128px from an SVG source.
 * Run once: node generate-icons.js
 * Requires: npm install canvas (or use the built-in approach below)
 *
 * This script uses the Canvas API to draw the icon programmatically,
 * avoiding any dependency on ImageMagick or external tools.
 */

import { createCanvas } from 'canvas';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, 'icons');
mkdirSync(ICONS_DIR, { recursive: true });

const SIZES = [16, 48, 128];

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const r = size * 0.12; // corner radius

  // Background: dark navy (#1a1a2e)
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();

  ctx.fillStyle = '#1a1a2e';
  ctx.fill();

  // Play triangle with gradient (orange → red)
  const gradient = ctx.createLinearGradient(size * 0.2, size * 0.2, size * 0.8, size * 0.8);
  gradient.addColorStop(0, '#FF6B35');
  gradient.addColorStop(1, '#FF3366');

  const margin = size * 0.22;
  ctx.beginPath();
  ctx.moveTo(margin, margin);
  ctx.lineTo(size - margin, size * 0.5);
  ctx.lineTo(margin, size - margin);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Hindi "ह" text (only legible at 48px and above)
  if (size >= 48) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.font = `bold ${Math.floor(size * 0.28)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ह', size * 0.44, size * 0.52);
  }

  return canvas.toBuffer('image/png');
}

// Check if 'canvas' package is available
try {
  for (const size of SIZES) {
    const buffer = drawIcon(size);
    const outPath = join(ICONS_DIR, `icon-${size}.png`);
    writeFileSync(outPath, buffer);
    console.log(`✅ Generated ${outPath}`);
  }
  console.log('\nAll icons generated successfully!');
} catch (err) {
  console.error('Canvas package not available. Install with: npm install canvas');
  console.error('Or use the fallback SVG-to-PNG approach.');
  console.error(err.message);
  process.exit(1);
}
