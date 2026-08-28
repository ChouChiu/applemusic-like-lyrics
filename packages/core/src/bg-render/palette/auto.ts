/**
 * @fileoverview
 * 自动在 K-Means 与八叉树两种取色结果之间择优。
 *
 * 逐行移植自 Storyteller-Studios/Impressionist（MIT）的
 * `Impressionist/Implementations/AutoPaletteGenerator.cs`。
 *
 * @see https://github.com/Storyteller-Studios/Impressionist/blob/master/Impressionist/Implementations/AutoPaletteGenerator.cs
 */

import { rgbToLab } from "./color-utilities.ts";
import {
	createKMeansPalette,
	createRandom,
	createThemeColor,
	seedFromHistogram,
} from "./kmeans.ts";
import { createOctTreePalette } from "./octtree.ts";
import type { ColorCount, ColorVec3, PaletteResult } from "./types.ts";

/** 调色板在 LAB 空间里到自身质心的平均平方距离，用来衡量色彩分散程度。 */
function calculateSpatialDiversity(palette: readonly ColorVec3[]): number {
	if (palette.length === 0) return 0;

	const labVectors = palette.map(rgbToLab);
	let centroidL = 0;
	let centroidA = 0;
	let centroidB = 0;
	for (const [l, a, b] of labVectors) {
		centroidL += l;
		centroidA += a;
		centroidB += b;
	}
	centroidL /= labVectors.length;
	centroidA /= labVectors.length;
	centroidB /= labVectors.length;

	let sumSquaredDistances = 0;
	for (const [l, a, b] of labVectors) {
		const dl = l - centroidL;
		const da = a - centroidA;
		const db = b - centroidB;
		sumSquaredDistances += dl * dl + da * da + db * db;
	}
	return sumSquaredDistances / labVectors.length;
}

/**
 * 同时跑两种取色算法并择优：暗色调色板偏好更分散的结果，亮色调色板反之偏好
 * 更聚拢的结果（八叉树在亮色上容易退化成一片惨白，所以 0 分散度直接判负）。
 */
export function createAutoPalette(
	sourceColors: readonly ColorCount[],
	clusterCount: number,
	ignoreWhite = false,
	toLab = false,
	useKMeansPP = false,
): PaletteResult {
	const random = createRandom(seedFromHistogram(sourceColors));
	const themeColor = createThemeColor(sourceColors, ignoreWhite, toLab, random);
	const kmeansResult = createKMeansPalette(
		sourceColors,
		clusterCount,
		themeColor,
		ignoreWhite,
		toLab,
		useKMeansPP,
		random,
	);
	const octTreeResult = createOctTreePalette(
		sourceColors,
		clusterCount,
		themeColor,
		ignoreWhite,
	);

	const kMeansDiversity = calculateSpatialDiversity(kmeansResult.palette);
	const octTreeDiversity = calculateSpatialDiversity(octTreeResult.palette);

	if (kmeansResult.paletteIsDark) {
		return kMeansDiversity >= octTreeDiversity ? kmeansResult : octTreeResult;
	}
	return kMeansDiversity <= octTreeDiversity || octTreeDiversity === 0
		? kmeansResult
		: octTreeResult;
}
