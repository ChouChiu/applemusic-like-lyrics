/**
 * @fileoverview
 * Isolation 背景渲染器。
 *
 * 使用仓库内实现的四点流动渐变着色器，着色器本体见
 * `isolation.frag.glsl`。
 *
 * 与另外两个渲染器不同，Isolation 完全是程序化的，并不采样封面纹理，而是从封面
 * 里提取四个主色来构造渐变，取色部分见 `../palette/index.ts`。
 */

import {
	loadResourceFromElement,
	loadResourceFromUrl,
} from "../../utils/resource.ts";
import { BaseRenderer } from "../base.ts";
import { GLProgram } from "../gl-program.ts";
import {
	createPaletteFromImage,
	type PaletteAlgorithm,
} from "../palette/index.ts";
import { isWebGL1Supported } from "../support.ts";
import isolationFragShader from "./isolation.frag.glsl?raw";
import isolationVertShader from "./isolation.vert.glsl?raw";

/** Isolation 渲染器的可调选项。 */
export interface IsolationRendererOptions {
	/** 是否启用 lightwave 明度调制，默认 `false`。 */
	lightWave: boolean;
	/** 是否启用屏幕空间抖动，默认 `true`。 */
	dithering: boolean;
	/** 取色算法，默认 `"auto"`。 */
	paletteAlgorithm: PaletteAlgorithm;
}

/** 换封面时调色板过渡的时长，单位毫秒。 */
const PALETTE_TRANSITION_MS = 1000;
/** 视频封面重新取色的间隔，单位毫秒。 */
const VIDEO_PALETTE_REFRESH_MS = 2000;
/** 圆周率的两倍，用来给 lightwave 的随机相位取值。 */
const TAU = Math.PI * 2;

type Rgb = [number, number, number];

/** 还没拿到封面时用的中性深色配色。 */
const DEFAULT_COLORS: readonly Rgb[] = [
	[0.09, 0.09, 0.11],
	[0.13, 0.13, 0.16],
	[0.07, 0.07, 0.09],
	[0.11, 0.11, 0.13],
];

function lerp(from: number, to: number, amount: number): number {
	return from + (to - from) * amount;
}

function cloneColors(colors: readonly Rgb[]): Rgb[] {
	return colors.map((color) => [...color] as Rgb);
}

function isPaletteAlgorithm(value: unknown): value is PaletteAlgorithm {
	return (
		value === "auto" ||
		value === "kmeans" ||
		value === "octtree"
	);
}

export class IsolationRenderer extends BaseRenderer {
	/**
	 * 新建实例时采用的默认选项。
	 *
	 * 该对象也可作为配置界面的初始值；实例创建后的调整统一走
	 * {@link setOptions}。
	 */
	static readonly defaultOptions: Readonly<IsolationRendererOptions> =
		Object.freeze({
			lightWave: false,
			dithering: true,
			paletteAlgorithm: "auto",
		});

	/** 当前环境是否支持该渲染器，选择渲染器前应先问一句。 */
	static isSupported(): boolean {
		return isWebGL1Supported();
	}

	private gl: WebGLRenderingContext;
	private program!: GLProgram;
	private quadBuffer!: WebGLBuffer;
	private contextLost = false;
	private _disposed = false;

	private options: IsolationRendererOptions = {
		...IsolationRenderer.defaultOptions,
	};

	private tickHandle = 0;
	private lastTickTime = 0;
	private lastFrameTime = 0;
	private frameTime = 0;
	private maxFPS = 30;
	private paused = false;
	private staticMode = false;

	private targetWidth = 0;
	private targetHeight = 0;
	private currentWidth = 0;
	private currentHeight = 0;

	private albumRequestId = 0;
	private albumSource?: HTMLImageElement | HTMLVideoElement;
	/** 距上次给视频封面重新取色经过的毫秒数。 */
	private sincePaletteRefresh = 0;

	private fromColors: Rgb[] = cloneColors(DEFAULT_COLORS);
	private toColors: Rgb[] = cloneColors(DEFAULT_COLORS);
	/**
	 * 调色板过渡已经过的毫秒数。
	 *
	 * 这里刻意不用 `performance.now()`：过渡必须和渲染时钟走同一套时间，否则
	 * 暂停、静态模式或限帧的时候过渡进度会和画面对不上。
	 */
	private paletteTransitionElapsed = PALETTE_TRANSITION_MS;
	private readonly colorBuffer = new Float32Array(12);
	private readonly randomValues = new Float32Array(3);
	private readonly paletteOrder = new Uint8Array([0, 1, 2, 3]);

	constructor(canvas: HTMLCanvasElement) {
		super(canvas);
		const gl = canvas.getContext("webgl", {
			alpha: false,
			antialias: false,
			depth: false,
			stencil: false,
			powerPreference: "low-power",
		});
		if (!gl) {
			this.disconnectResizeObserver();
			throw new Error("WebGL not supported");
		}
		this.gl = gl;
		try {
			this.rollRandomValues();
			this.initializeGLResources();
		} catch (error) {
			this.program?.dispose();
			gl.getExtension("WEBGL_lose_context")?.loseContext();
			this.disconnectResizeObserver();
			throw error;
		}
		canvas.addEventListener("webglcontextlost", this.onContextLost);
		canvas.addEventListener("webglcontextrestored", this.onContextRestored);
		this.requestTick();
	}

	private initializeGLResources(): void {
		const gl = this.gl;
		this.program = new GLProgram(
			gl,
			isolationVertShader,
			isolationFragShader,
			"isolation",
		);
		const buffer = gl.createBuffer();
		if (!buffer) throw new Error("Failed to create quad buffer");
		this.quadBuffer = buffer;
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(
			gl.ARRAY_BUFFER,
			new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
			gl.STATIC_DRAW,
		);
	}

	private readonly onContextLost = (event: Event): void => {
		event.preventDefault();
		this.contextLost = true;
		if (this.tickHandle) {
			cancelAnimationFrame(this.tickHandle);
			this.tickHandle = 0;
		}
	};

	private readonly onContextRestored = (): void => {
		if (this._disposed) return;
		this.contextLost = false;
		this.initializeGLResources();
		this.currentWidth = 0;
		this.currentHeight = 0;
		this.requestTick();
	};

	private rollRandomValues(): void {
		// 每次换封面重掷，但在同一张封面期间保持稳定，避免画面逐帧跳变
		for (let i = 0; i < 3; i++) this.randomValues[i] = Math.random() * TAU;
		for (let i = 0; i < this.paletteOrder.length; i++) {
			this.paletteOrder[i] = i;
		}
		for (let i = this.paletteOrder.length - 1; i > 0; i--) {
			const swapIndex = Math.floor(Math.random() * (i + 1));
			const current = this.paletteOrder[i];
			this.paletteOrder[i] = this.paletteOrder[swapIndex];
			this.paletteOrder[swapIndex] = current;
		}
	}

	/** 调整渲染器选项，会立即生效。 */
	setOptions(patch: Partial<IsolationRendererOptions>): void {
		const nextAlgorithm = isPaletteAlgorithm(patch.paletteAlgorithm)
			? patch.paletteAlgorithm
			: undefined;
		const algorithmChanged =
			nextAlgorithm !== undefined &&
			nextAlgorithm !== this.options.paletteAlgorithm;
		this.options = {
			lightWave:
				typeof patch.lightWave === "boolean"
					? patch.lightWave
					: this.options.lightWave,
			dithering:
				typeof patch.dithering === "boolean"
					? patch.dithering
					: this.options.dithering,
			paletteAlgorithm: nextAlgorithm ?? this.options.paletteAlgorithm,
		};
		if (algorithmChanged && this.albumSource) {
			this.updatePaletteFromSource(this.albumSource, true);
		}
		this.requestTick();
	}

	/** 读取当前选项。 */
	getOptions(): IsolationRendererOptions {
		return { ...this.options };
	}

	private updatePaletteFromSource(
		source: HTMLImageElement | HTMLVideoElement,
		immediate = false,
	): void {
		let palette: number[][];
		try {
			palette = createPaletteFromImage(source, 4, {
				algorithm: this.options.paletteAlgorithm,
			}).palette;
		} catch (err) {
			// 跨域封面会让 getImageData 抛安全错误，此时保持现有配色
			console.warn("Failed to extract palette from album", err);
			return;
		}
		const next = Array.from(this.paletteOrder, (colorIndex) => {
			const color = palette[colorIndex] ?? palette[0] ?? [0, 0, 0];
			return [color[0] / 255, color[1] / 255, color[2] / 255] as Rgb;
		});
		this.transitionToColors(next, immediate);
		this.sincePaletteRefresh = 0;
		this.requestTick();
	}

	private transitionToColors(next: readonly Rgb[], immediate: boolean): void {
		this.fromColors = immediate ? cloneColors(next) : this.resolveColors();
		this.toColors = cloneColors(next);
		this.paletteTransitionElapsed = immediate ? PALETTE_TRANSITION_MS : 0;
	}

	private resolveColors(): Rgb[] {
		const elapsed = this.paletteTransitionElapsed;
		if (elapsed >= PALETTE_TRANSITION_MS) {
			return cloneColors(this.toColors);
		}
		const progress = Math.min(1, Math.max(0, elapsed / PALETTE_TRANSITION_MS));
		// 平滑一下，避免过渡首尾出现颜色突变
		const eased = progress * progress * (3 - 2 * progress);
		return this.toColors.map((to, index) => {
			const from = this.fromColors[index] ?? to;
			return [
				lerp(from[0], to[0], eased),
				lerp(from[1], to[1], eased),
				lerp(from[2], to[2], eased),
			] as Rgb;
		});
	}

	private checkIfResize(): void {
		if (
			this.targetWidth === this.currentWidth &&
			this.targetHeight === this.currentHeight
		) {
			return;
		}
		super.onResize(this.targetWidth, this.targetHeight);
		this.currentWidth = this.targetWidth;
		this.currentHeight = this.targetHeight;
		this.gl.viewport(0, 0, this.targetWidth, this.targetHeight);
	}

	private onRedraw(frameTime: number, frameDelta: number): boolean {
		const gl = this.gl;
		this.checkIfResize();
		if (this.currentWidth <= 0 || this.currentHeight <= 0) return false;

		if (this.paletteTransitionElapsed < PALETTE_TRANSITION_MS) {
			this.paletteTransitionElapsed += frameDelta;
		}
		this.sincePaletteRefresh += frameDelta;
		if (
			this.albumSource instanceof HTMLVideoElement &&
			this.sincePaletteRefresh >= VIDEO_PALETTE_REFRESH_MS
		) {
			this.updatePaletteFromSource(this.albumSource);
		}

		const colors = this.resolveColors();
		for (let i = 0; i < 4; i++) {
			const color = colors[i] ?? DEFAULT_COLORS[i];
			this.colorBuffer[i * 3] = color[0];
			this.colorBuffer[i * 3 + 1] = color[1];
			this.colorBuffer[i * 3 + 2] = color[2];
		}

		this.program.use();
		this.program.setUniform2f(
			"u_resolution",
			this.currentWidth,
			this.currentHeight,
		);
		this.program.setUniform1f("u_time", frameTime / 1000);
		this.program.setUniform3fv("u_colors[0]", this.colorBuffer);
		this.program.setUniform3f(
			"u_random",
			this.randomValues[0],
			this.randomValues[1],
			this.randomValues[2],
		);
		this.program.setUniform1i(
			"u_enableLightWave",
			this.options.lightWave ? 1 : 0,
		);
		this.program.setUniform1i(
			"u_enableDithering",
			this.options.dithering ? 1 : 0,
		);

		const position = this.program.attrs.a_position;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
		gl.enableVertexAttribArray(position);
		gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
		gl.drawArrays(gl.TRIANGLES, 0, 6);

		// 调色板过渡跑完之后才允许静态模式停下来
		return this.paletteTransitionElapsed >= PALETTE_TRANSITION_MS;
	}

	private onTick(tickTime: number): void {
		this.tickHandle = 0;
		if (this.paused || this._disposed || this.contextLost) return;

		const interval = 1000 / this.maxFPS;
		const delta = tickTime - this.lastTickTime;
		if (delta < interval) {
			this.requestTick();
			return;
		}

		if (Number.isNaN(this.lastFrameTime)) this.lastFrameTime = tickTime;
		// 切后台回来或时钟被调整时 delta 可能异常甚至为负，钳制一下，
		// 否则调色板过渡的进度会跑到 [0, 1] 之外，颜色被外推到饱和
		const frameDelta = Math.min(
			Math.max(tickTime - this.lastFrameTime, 0),
			250,
		);
		this.lastFrameTime = tickTime;
		this.lastTickTime = tickTime - (delta % interval);

		this.frameTime += frameDelta * this.flowSpeed;

		if (!(this.onRedraw(this.frameTime, frameDelta) && this.staticMode)) {
			this.requestTick();
		} else {
			this.lastFrameTime = Number.NaN;
		}
	}

	private readonly onTickBinded = this.onTick.bind(this);

	private requestTick(): void {
		if (this._disposed || this.paused || this.contextLost || this.maxFPS <= 0) {
			return;
		}
		if (this.tickHandle === 0) {
			this.tickHandle = requestAnimationFrame(this.onTickBinded);
		}
	}

	protected override onResize(width: number, height: number): void {
		this.targetWidth = Math.ceil(width);
		this.targetHeight = Math.ceil(height);
		this.requestTick();
	}

	override setStaticMode(enable: boolean): void {
		this.staticMode = enable;
		this.resetFrameClock();
		this.requestTick();
	}

	override setFPS(fps: number): void {
		this.maxFPS = Number.isFinite(fps) ? Math.max(0, fps) : 0;
		if (this.maxFPS === 0) {
			if (this.tickHandle) cancelAnimationFrame(this.tickHandle);
			this.tickHandle = 0;
			return;
		}
		this.resetFrameClock();
		this.requestTick();
	}

	override pause(): void {
		if (this.tickHandle) {
			cancelAnimationFrame(this.tickHandle);
			this.tickHandle = 0;
		}
		this.paused = true;
	}

	override resume(): void {
		this.paused = false;
		this.resetFrameClock();
		this.requestTick();
	}

	private resetFrameClock(): void {
		const now = performance.now();
		this.lastFrameTime = now;
		this.lastTickTime = now;
	}

	override async setAlbum(
		albumSource?: string | HTMLImageElement | HTMLVideoElement,
		isVideo?: boolean,
	): Promise<void> {
		const requestId = ++this.albumRequestId;
		if (
			albumSource === undefined ||
			(typeof albumSource === "string" && albumSource.trim().length === 0)
		) {
			this.albumSource = undefined;
			this.transitionToColors(DEFAULT_COLORS, false);
			this.requestTick();
			return;
		}

		const source =
			typeof albumSource === "string"
				? await loadResourceFromUrl(albumSource, isVideo)
				: await loadResourceFromElement(albumSource);
		if (requestId !== this.albumRequestId || this._disposed) return;

		this.albumSource = source;
		this.rollRandomValues();
		this.updatePaletteFromSource(source);
	}

	override setLowFreqVolume(_volume: number): void {
		// Isolation 是纯程序化的渐变，不随音量变化
	}

	override setHasLyric(_hasLyric: boolean): void {
		// Isolation 的观感与是否有歌词无关，这里不做处理
	}

	override dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		if (this.tickHandle) {
			cancelAnimationFrame(this.tickHandle);
			this.tickHandle = 0;
		}
		this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
		this.canvas.removeEventListener(
			"webglcontextrestored",
			this.onContextRestored,
		);
		this.program?.dispose();
		this.gl.deleteBuffer(this.quadBuffer);
		this.gl.getExtension("WEBGL_lose_context")?.loseContext();
		super.dispose();
	}
}
