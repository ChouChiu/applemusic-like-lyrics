/**
 * @fileoverview
 * 渲染器的运行环境能力探测。
 *
 * 渲染器的构造函数在拿不到所需上下文时会直接抛错，而 `BackgroundRender.new()`
 * 只是 `new` 一下，没有回落余地。所以选择渲染器的一方（设置界面、从
 * localStorage 恢复配置的地方）应当先问一句支不支持。
 */

let webgl1Support: boolean | undefined;
let webgl2Support: boolean | undefined;

function probe(contextId: "webgl" | "webgl2"): boolean {
	try {
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		const gl = canvas.getContext(contextId) as
			| WebGLRenderingContext
			| WebGL2RenderingContext
			| null;
		if (!gl) return false;
		// 探测用的上下文用完立刻释放，免得白占一个 WebGL 上下文名额
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		return true;
	} catch {
		return false;
	}
}

/** 当前环境是否支持 WebGL1，结果只探测一次。 */
export function isWebGL1Supported(): boolean {
	if (webgl1Support === undefined) webgl1Support = probe("webgl");
	return webgl1Support;
}

/** 当前环境是否支持 WebGL2，结果只探测一次。 */
export function isWebGL2Supported(): boolean {
	if (webgl2Support === undefined) webgl2Support = probe("webgl2");
	return webgl2Support;
}
