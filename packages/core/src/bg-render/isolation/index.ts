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
	channelToLinear,
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
/** 圆周率的两倍，用来给 lightwave 的随机相位取值。 */
const TAU = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;
/** 渐变用到的颜色数量，也是 {@link colorBuffer} 等缓冲的长度依据。 */
const COLOR_COUNT = 4;
/** 加载封面失败时的重试次数，与其它渲染器保持一致。 */
const ALBUM_RETRY_TIMES = 5;

/** 还没拿到封面时用的中性深色配色，分量取值 [0, 1] 的 sRGB。 */
const DEFAULT_COLORS: readonly (readonly [number, number, number])[] = [
	[0.09, 0.09, 0.11],
	[0.13, 0.13, 0.16],
	[0.07, 0.07, 0.09],
	[0.11, 0.11, 0.13],
];

function lerp(from: number, to: number, amount: number): number {
	return from + (to - from) * amount;
}

/**
 * 把一个 sRGB 颜色转成 OkLab 并写进 `out` 的指定偏移，分量取值均为 [0, 1]。
 *
 * 着色器在 OkLab 空间做感知均匀的混色，转换本身对整个 draw call 是常量，所以放
 * 在 CPU 上每帧算四次，而不是丢给片元着色器每像素算四次。JS 侧的调色板过渡也因
 * 此和着色器落在同一个色彩空间里，换封面时的中间色不会发暗发浊。
 */
function writeSrgbAsOkLab(
	out: Float32Array,
	offset: number,
	red: number,
	green: number,
	blue: number,
): void {
	const linearRed = channelToLinear(red);
	const linearGreen = channelToLinear(green);
	const linearBlue = channelToLinear(blue);
	const l = Math.cbrt(
		0.4122214708 * linearRed +
			0.5363325363 * linearGreen +
			0.0514459929 * linearBlue,
	);
	const m = Math.cbrt(
		0.2119034982 * linearRed +
			0.6806995451 * linearGreen +
			0.1073969566 * linearBlue,
	);
	const s = Math.cbrt(
		0.0883024619 * linearRed +
			0.2817188376 * linearGreen +
			0.6299787005 * linearBlue,
	);
	out[offset] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	out[offset + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	out[offset + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

function toOkLabBuffer(
	colors: readonly (readonly [number, number, number])[],
): Float32Array {
	const buffer = new Float32Array(COLOR_COUNT * 3);
	for (let i = 0; i < COLOR_COUNT; i++) {
		const [red, green, blue] = colors[i];
		writeSrgbAsOkLab(buffer, i * 3, red, green, blue);
	}
	return buffer;
}

/** {@link DEFAULT_COLORS} 的 OkLab 形式，着色器要的就是这个。 */
const DEFAULT_OKLAB_COLORS = toOkLabBuffer(DEFAULT_COLORS);

let highpFragmentSupport: boolean | undefined;

/**
 * WebGL1 的片元着色器是否支持 highp，结果只探测一次。
 *
 * 着色器里 `u_time` 会一直单调累加，而噪声哈希又是 `sin(...) * 43758.5453`
 * 这种把误差放大四万倍的写法。mediump 只有 10 位有效数，播放几分钟后时间项就会
 * 量化到肉眼可见的台阶，哈希本身也会退化成条带 —— 与其默默给出破图，不如直接判
 * 定为不支持。
 */
function isHighpFragmentSupported(): boolean {
	if (highpFragmentSupport !== undefined) return highpFragmentSupport;
	highpFragmentSupport = false;
	try {
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		const gl = canvas.getContext("webgl");
		if (!gl) return highpFragmentSupport;
		const format = gl.getShaderPrecisionFormat(
			gl.FRAGMENT_SHADER,
			gl.HIGH_FLOAT,
		);
		// 探测用的上下文用完立刻释放，免得白占一个 WebGL 上下文名额
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		highpFragmentSupport = (format?.precision ?? 0) > 0;
	} catch {
		highpFragmentSupport = false;
	}
	return highpFragmentSupport;
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
		return isWebGL1Supported() && isHighpFragmentSupported();
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

	/**
	 * 调色板过渡已经过的毫秒数。
	 *
	 * 这里刻意不用 `performance.now()`：过渡必须和渲染时钟走同一套时间，否则
	 * 暂停、静态模式或限帧的时候过渡进度会和画面对不上。
	 */
	private paletteTransitionElapsed = PALETTE_TRANSITION_MS;
	/** 过渡起点、终点与当前帧的颜色，均为 OkLab，四个颜色首尾相接。 */
	private readonly fromColors = new Float32Array(DEFAULT_OKLAB_COLORS);
	private readonly toColors = new Float32Array(DEFAULT_OKLAB_COLORS);
	private readonly colorBuffer = new Float32Array(DEFAULT_OKLAB_COLORS);
	/** 取色结果的暂存区，避免每次换封面都新建数组。 */
	private readonly nextColors = new Float32Array(COLOR_COUNT * 3);

	private readonly randomValues = new Float32Array(3);
	/**
	 * 整帧恒定的渐变流动参数，依次是波纹频率、波纹幅度、流动速度（已含方向）与
	 * 渐变轴倾角（弧度）。原实现是在片元着色器里用随机哈希现算的，但它们对整个
	 * draw call 都是常量，挪到 CPU 上每帧算一次即可。
	 */
	private readonly flowParams = new Float32Array(4);
	/** 渐变轴叠加在噪声角度上的抖动，单位弧度，同样是整帧常量。 */
	private angleJitter = 0;
	private readonly paletteOrder = new Uint8Array(COLOR_COUNT);

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
			this.rollRandomParameters();
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
		try {
			this.initializeGLResources();
		} catch (error) {
			// 重建失败就维持「上下文丢失」的状态，别再往一个残缺的上下文上画
			this.contextLost = true;
			this.program?.dispose();
			console.error("Failed to restore WebGL resources", error);
			return;
		}
		this.currentWidth = 0;
		this.currentHeight = 0;
		this.requestTick();
	};

	/** 重掷整张封面期间保持不变的随机参数，避免画面逐帧跳变。 */
	private rollRandomParameters(): void {
		for (let i = 0; i < this.randomValues.length; i++) {
			this.randomValues[i] = Math.random() * TAU;
		}
		const direction = Math.random() < 0.5 ? -1 : 1;
		this.flowParams[0] = lerp(4.5, 5.5, Math.random());
		this.flowParams[1] = lerp(22, 29, Math.random());
		this.flowParams[2] = lerp(0.65, 0.85, Math.random()) * direction;
		this.flowParams[3] = (-5 + (Math.random() - 0.5) * 12) * DEG_TO_RAD;
		this.angleJitter = (Math.random() - 0.5) * 0.3;
		for (let i = 0; i < this.paletteOrder.length; i++) {
			this.paletteOrder[i] = i;
		}
		for (let i = this.paletteOrder.length - 1; i > 0; i--) {
			const swapIndex = Math.floor(Math.random() * (i + 1));
			[this.paletteOrder[i], this.paletteOrder[swapIndex]] = [
				this.paletteOrder[swapIndex],
				this.paletteOrder[i],
			];
		}
	}

	/** 调整渲染器选项，会立即生效。 */
	setOptions(patch: Partial<IsolationRendererOptions>): void {
		const algorithmChanged =
			patch.paletteAlgorithm !== undefined &&
			patch.paletteAlgorithm !== this.options.paletteAlgorithm;
		this.options = { ...this.options, ...patch };
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
		let palette: [number, number, number][];
		try {
			palette = createPaletteFromImage(source, COLOR_COUNT, {
				algorithm: this.options.paletteAlgorithm,
			}).palette;
		} catch (err) {
			// 跨域封面会让 getImageData 抛安全错误，此时保持现有配色
			console.warn("Failed to extract palette from album", err);
			return;
		}
		for (let i = 0; i < COLOR_COUNT; i++) {
			const [red, green, blue] = palette[this.paletteOrder[i]];
			writeSrgbAsOkLab(
				this.nextColors,
				i * 3,
				red / 255,
				green / 255,
				blue / 255,
			);
		}
		this.transitionToColors(this.nextColors, immediate);
		this.requestTick();
	}

	private transitionToColors(next: Float32Array, immediate: boolean): void {
		if (immediate) {
			this.fromColors.set(next);
		} else {
			// 从当前这一帧的实际颜色接着往下过渡，免得连续换封面时颜色回跳
			this.updateColorBuffer();
			this.fromColors.set(this.colorBuffer);
		}
		this.toColors.set(next);
		this.paletteTransitionElapsed = immediate ? PALETTE_TRANSITION_MS : 0;
	}

	/** 按当前过渡进度就地更新 {@link colorBuffer}，不产生任何中间数组。 */
	private updateColorBuffer(): void {
		if (this.paletteTransitionElapsed >= PALETTE_TRANSITION_MS) {
			this.colorBuffer.set(this.toColors);
			return;
		}
		const progress = this.paletteTransitionElapsed / PALETTE_TRANSITION_MS;
		// 平滑一下，避免过渡首尾出现颜色突变
		const eased = progress * progress * (3 - 2 * progress);
		for (let i = 0; i < this.colorBuffer.length; i++) {
			this.colorBuffer[i] = lerp(this.fromColors[i], this.toColors[i], eased);
		}
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
		this.updateColorBuffer();

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
		this.program.setUniform4f(
			"u_flowParams",
			this.flowParams[0],
			this.flowParams[1],
			this.flowParams[2],
			this.flowParams[3],
		);
		this.program.setUniform1f("u_angleJitter", this.angleJitter);
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

	/**
	 * 该次 `setAlbum` 是否还是最新的一次。
	 *
	 * 与 `MeshGradientRenderer` 不同，这里不看 `contextLost`：取色全在 CPU
	 * 上做，上下文丢了也照样能把调色板算完存着，等上下文恢复直接就能画。
	 */
	private isCurrentAlbumRequest(requestId: number): boolean {
		return !this._disposed && requestId === this.albumRequestId;
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
			this.transitionToColors(DEFAULT_OKLAB_COLORS, false);
			this.requestTick();
			return;
		}

		let source: HTMLImageElement | HTMLVideoElement | null = null;
		let remainRetryTimes = ALBUM_RETRY_TIMES;
		while (!source && remainRetryTimes > 0) {
			try {
				source =
					typeof albumSource === "string"
						? await loadResourceFromUrl(albumSource, isVideo)
						: await loadResourceFromElement(albumSource);
			} catch (error) {
				if (!this.isCurrentAlbumRequest(requestId)) return;
				remainRetryTimes--;
				console.warn(
					`failed on loading album resource, retrying (${remainRetryTimes})`,
					{ albumSource, error },
				);
			}
		}
		if (!this.isCurrentAlbumRequest(requestId)) return;
		if (!source) {
			console.error("Failed to load album resource", albumSource);
			return;
		}

		this.albumSource = source;
		this.rollRandomParameters();
		// 视频封面只取首帧的主色：取色是同步的重活，按秒重复跑会在主线程上留下
		// 周期性卡顿，MeshGradientRenderer 也是这么处理的
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
