/**
 * @fileoverview
 * 色彩空间转换与明暗判定。
 *
 * 逐行移植自 Storyteller-Studios/Impressionist（MIT）的
 * `Impressionist/Implementations/ColorUtilities.cs`。
 */

import type { ColorVec3, HSVColor } from "./types.ts";

export function rgbToHsv(color: ColorVec3): HSVColor {
	const [r, g, b] = color;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);

	const v = (max * 100) / 255;
	if (max === min) return { h: 0, s: 0, v };

	const s = ((max - min) / max) * 100;
	let h = 0;
	if (max === r) {
		h = (60 * (g - b)) / (max - min);
	} else if (max === g) {
		h = 60 * (2 + (b - r) / (max - min));
	} else {
		h = 60 * (4 + (r - g) / (max - min));
	}
	if (h < 0) h += 360;
	return { h, s, v };
}

export function hsvToRgb(hsv: HSVColor): ColorVec3 {
	const h = hsv.h === 360 ? 0 : hsv.h;
	const hi = Math.floor(h / 60) % 6;
	const f = h / 60 - hi;
	const p = (hsv.v / 100) * (1 - hsv.s / 100) * 255;
	const q = (hsv.v / 100) * (1 - f * (hsv.s / 100)) * 255;
	const t = (hsv.v / 100) * (1 - (1 - f) * (hsv.s / 100)) * 255;
	const v = (hsv.v * 255) / 100;

	switch (hi) {
		case 0:
			return [v, t, p];
		case 1:
			return [q, v, p];
		case 2:
			return [p, v, t];
		case 3:
			return [p, q, v];
		case 4:
			return [t, p, v];
		default:
			return [v, p, q];
	}
}

export function rgbToXyz(rgb: ColorVec3): ColorVec3 {
	const r = rgb[0] / 255;
	const g = rgb[1] / 255;
	const b = rgb[2] / 255;
	return [
		r * 0.4124 + g * 0.3576 + b * 0.1805,
		r * 0.2126 + g * 0.7152 + b * 0.0722,
		r * 0.0193 + g * 0.1192 + b * 0.9505,
	];
}

export function xyzToRgb(xyz: ColorVec3): ColorVec3 {
	const [x, y, z] = xyz;
	return [
		(x * 3.2406 - y * 1.5372 - z * 0.4986) * 255,
		(-x * 0.9689 + y * 1.8758 + z * 0.0415) * 255,
		(x * 0.0557 - y * 0.204 + z * 1.057) * 255,
	];
}

const D65_X = 0.95047;
const D65_Y = 1;
const D65_Z = 1.0883;

function fxyz(t: number): number {
	return t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116;
}

export function xyzToLab(xyz: ColorVec3): ColorVec3 {
	const [x, y, z] = xyz;
	return [
		116 * fxyz(y / D65_Y) - 16,
		500 * (fxyz(x / D65_X) - fxyz(y / D65_Y)),
		200 * (fxyz(y / D65_Y) - fxyz(z / D65_Z)),
	];
}

export function labToXyz(lab: ColorVec3): ColorVec3 {
	const delta = 6 / 29;
	const [l, a, b] = lab;
	const fy = (l + 16) / 116;
	const fx = fy + a / 500;
	const fz = fy - b / 200;
	return [
		fx > delta
			? D65_X * fx * fx * fx
			: (fx - 16 / 116) * 3 * delta * delta * D65_X,
		fy > delta
			? D65_Y * fy * fy * fy
			: (fy - 16 / 116) * 3 * delta * delta * D65_Y,
		fz > delta
			? D65_Z * fz * fz * fz
			: (fz - 16 / 116) * 3 * delta * delta * D65_Z,
	];
}

export function rgbToLab(rgb: ColorVec3): ColorVec3 {
	return xyzToLab(rgbToXyz(rgb));
}

export function labToRgb(lab: ColorVec3): ColorVec3 {
	return xyzToRgb(labToXyz(lab));
}

export function channelToLinear(value: number): number {
	return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function yToLStar(y: number): number {
	// CIE 标准写的是 0.008856 与 903.3，但 216/24389 和 24389/27 才是其本意
	if (y <= 216 / 24389) return y * (24389 / 27);
	return y ** (1 / 3) * 116 - 16;
}

function lStar(rgb: ColorVec3): number {
	const y =
		0.2126 * channelToLinear(rgb[0] / 255) +
		0.7152 * channelToLinear(rgb[1] / 255) +
		0.0722 * channelToLinear(rgb[2] / 255);
	return yToLStar(y);
}

/** 调色板取色时判定「暗色候选」的阈值，比主题色判定更严格。 */
export function paletteRgbLStarIsDark(rgb: ColorVec3): boolean {
	return lStar(rgb) <= 40;
}

/** 调色板取色时判定「亮色候选」的阈值。 */
export function paletteRgbLStarIsLight(rgb: ColorVec3): boolean {
	return lStar(rgb) >= 60;
}

/** 主题色的明暗判定。 */
export function rgbLStarIsDark(rgb: ColorVec3): boolean {
	return lStar(rgb) <= 50;
}

/** 两个颜色向量的欧氏距离平方。 */
export function distanceSquared(a: ColorVec3, b: ColorVec3): number {
	const dx = a[0] - b[0];
	const dy = a[1] - b[1];
	const dz = a[2] - b[2];
	return dx * dx + dy * dy + dz * dz;
}
