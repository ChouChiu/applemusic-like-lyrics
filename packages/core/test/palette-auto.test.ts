import { describe, expect, it } from "vitest";
import { createAutoPalette } from "../src/bg-render/palette/auto.ts";
import {
	createKMeansPalette,
	createRandom,
	createThemeColor,
	seedFromHistogram,
} from "../src/bg-render/palette/kmeans.ts";
import { createOctTreePalette } from "../src/bg-render/palette/octtree.ts";
import type { ColorCount, ColorVec3 } from "../src/bg-render/palette/types.ts";

const CLUSTER_COUNT = 4;

function distinct(palette: readonly ColorVec3[]): number {
	return new Set(palette.map((color) => color.join(","))).size;
}

function hex(value: string): ColorVec3 {
	const n = Number.parseInt(value.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 沿对角线在若干色标之间线性渐变，再统计直方图。
 *
 * 直接手写几条直方图项复现不出问题：真实封面缩到 64×64 之后有上百个相近颜色，
 * 八叉树正是在这种分布上退化的。
 */
function gradientHistogram(stops: string[], size = 64): ColorCount[] {
	const colors = stops.map(hex);
	const counts = new Map<number, number>();
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const t = (x + y) / (2 * (size - 1));
			const seg = Math.min(
				colors.length - 2,
				Math.floor(t * (colors.length - 1)),
			);
			const f = t * (colors.length - 1) - seg;
			const from = colors[seg];
			const to = colors[seg + 1];
			const key =
				(Math.round(from[0] + (to[0] - from[0]) * f) << 16) |
				(Math.round(from[1] + (to[1] - from[1]) * f) << 8) |
				Math.round(from[2] + (to[2] - from[2]) * f);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return Array.from(counts, ([key, count]) => ({
		color: [(key >> 16) & 255, (key >> 8) & 255, key & 255] as ColorVec3,
		count,
	}));
}

/** 按 {@link createAutoPalette} 内部同样的顺序复现两个候选，用来断言它选了哪个。 */
function candidates(entries: readonly ColorCount[]) {
	const random = createRandom(seedFromHistogram(entries));
	const themeColor = createThemeColor(entries, false, false, random);
	return {
		kmeans: createKMeansPalette(
			entries,
			CLUSTER_COUNT,
			themeColor,
			false,
			false,
			false,
			random,
		),
		octTree: createOctTreePalette(entries, CLUSTER_COUNT, themeColor, false),
	};
}

const PASTEL = gradientHistogram(["#ffe8f0", "#ffd9a8", "#cfe9ff", "#e8ffe2"]);
const DARK = gradientHistogram(["#1a1026", "#3b1f2b", "#0d1b2a", "#241a12"]);

describe("createAutoPalette", () => {
	it("亮色封面上不会选中被重复填充的调色板", () => {
		const { kmeans, octTree } = candidates(PASTEL);
		// 前提：这张图上八叉树确实凑不满，K-Means 能凑满
		expect(distinct(octTree.palette)).toBeLessThan(CLUSTER_COUNT);
		expect(distinct(kmeans.palette)).toBe(CLUSTER_COUNT);

		const auto = createAutoPalette(PASTEL, CLUSTER_COUNT);
		// 重复色会拉低分散度，原先的亮色分支「偏好更聚拢」正好会选中退化的那支
		expect(distinct(auto.palette)).toBe(CLUSTER_COUNT);
		expect(auto.palette).toEqual(kmeans.palette);
	});

	it("颜色数打平时仍按分散度择优，只做挑选不合成新色", () => {
		const { kmeans, octTree } = candidates(DARK);
		expect(distinct(kmeans.palette)).toBe(distinct(octTree.palette));

		const auto = createAutoPalette(DARK, CLUSTER_COUNT);
		expect([kmeans.palette, octTree.palette]).toContainEqual(auto.palette);
	});

	it("两个候选都凑不满时如实返回重复色", () => {
		const solid: ColorCount[] = [{ color: [200, 180, 160], count: 4096 }];
		const auto = createAutoPalette(solid, CLUSTER_COUNT);
		expect(auto.palette).toHaveLength(CLUSTER_COUNT);
		expect(distinct(auto.palette)).toBe(1);
	});
});
