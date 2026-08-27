/**
 * @fileoverview
 * 调色板取色器的公共类型。
 *
 * 移植自 Storyteller-Studios/Impressionist（MIT）：
 * - `Impressionist/Abstractions/HSVColor.cs`
 * - `Impressionist/Abstractions/PaletteResult.cs`
 *
 * 颜色一律用 `[x, y, z]` 三元组表示。在 RGB 空间时分量范围是 [0, 255]，
 * 与 C# 原实现的 `Vector3` 约定保持一致；在 LAB 空间时则是 L/a/b 的原始取值。
 */

/** 一个颜色向量，语义随所处色彩空间而定。 */
export type ColorVec3 = [number, number, number];

/** HSV 颜色，H 取值 [0, 360)，S/V 取值 [0, 100]。 */
export interface HSVColor {
	h: number;
	s: number;
	v: number;
}

/** 直方图中的一项：一个颜色及其出现次数。 */
export interface ColorCount {
	color: ColorVec3;
	count: number;
}

/** 主题色结果。 */
export interface ThemeColorResult {
	/** RGB 空间下的主题色，分量范围 [0, 255]。 */
	color: ColorVec3;
	/** 该主题色是否偏暗（L* <= 50）。 */
	colorIsDark: boolean;
}

/** 调色板结果。 */
export interface PaletteResult {
	/** 调色板颜色，RGB 空间，分量范围 [0, 255]，长度恒等于请求的数量。 */
	palette: ColorVec3[];
	/** 该调色板整体是否偏暗。 */
	paletteIsDark: boolean;
	/** 生成调色板时顺带算出的主题色。 */
	themeColor: ThemeColorResult;
}
