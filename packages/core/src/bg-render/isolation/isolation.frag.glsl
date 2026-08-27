// WebGL1 port of Storyteller-Studios/Cirrus' IsolationEffect.
// The three random values are re-rolled per album by IsolationRenderer, so a
// cover gets a stable composition while different covers do not share a layout.

#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_colors[4];
uniform vec3 u_random;
uniform bool u_enableLightWave;
uniform bool u_enableDithering;

const float PI = 3.141592653589793;

vec2 rotatePoint(vec2 point, float angle) {
	float sine = sin(angle);
	float cosine = cos(angle);
	return vec2(
		point.x * cosine - point.y * sine,
		point.x * sine + point.y * cosine
	);
}

vec2 gradientHash(vec2 point) {
	return fract(
		sin(
			vec2(
				dot(point, vec2(127.1, 311.7)),
				dot(point, vec2(269.5, 183.3))
			)
		) * 43758.5453
	);
}

float gradientNoise(vec2 point) {
	vec2 cell = floor(point);
	vec2 offset = fract(point);
	vec2 eased = offset * offset * (3.0 - 2.0 * offset);
	float lower = mix(
		dot(-1.0 + 2.0 * gradientHash(cell), offset),
		dot(-1.0 + 2.0 * gradientHash(cell + vec2(1.0, 0.0)), offset - vec2(1.0, 0.0)),
		eased.x
	);
	float upper = mix(
		dot(-1.0 + 2.0 * gradientHash(cell + vec2(0.0, 1.0)), offset - vec2(0.0, 1.0)),
		dot(-1.0 + 2.0 * gradientHash(cell + vec2(1.0, 1.0)), offset - vec2(1.0, 1.0)),
		eased.x
	);
	return 0.5 + 0.5 * mix(lower, upper, eased.y);
}

float random01(float seed) {
	return fract(sin(seed * 12.9898 + 78.233) * 43758.5453);
}

float smoothstepRange(float edge0, float edge1, float value) {
	float amount = clamp((value - edge0) / (edge1 - edge0), 0.0, 1.0);
	return amount * amount * (3.0 - 2.0 * amount);
}

float decodeSrgb(float channel) {
	return channel <= 0.04045
		? channel / 12.92
		: pow((channel + 0.055) / 1.055, 2.4);
}

float encodeSrgb(float channel) {
	return channel <= 0.0031308
		? 12.92 * channel
		: 1.055 * pow(max(channel, 0.0), 1.0 / 2.4) - 0.055;
}

vec3 srgbToOkLab(vec3 color) {
	color = clamp(color, 0.0, 1.0);
	vec3 linearColor = vec3(
		decodeSrgb(color.r),
		decodeSrgb(color.g),
		decodeSrgb(color.b)
	);
	float l = dot(linearColor, vec3(0.4122214708, 0.5363325363, 0.0514459929));
	float m = dot(linearColor, vec3(0.2119034982, 0.6806995451, 0.1073969566));
	float s = dot(linearColor, vec3(0.0883024619, 0.2817188376, 0.6299787005));
	vec3 roots = pow(max(vec3(l, m, s), vec3(0.0)), vec3(1.0 / 3.0));
	return vec3(
		dot(roots, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
		dot(roots, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
		dot(roots, vec3(0.0259040371, 0.7827717662, -0.8086757660))
	);
}

vec3 okLabToSrgb(vec3 color) {
	float lRoot = color.x + 0.3963377774 * color.y + 0.2158037573 * color.z;
	float mRoot = color.x - 0.1055613458 * color.y - 0.0638541728 * color.z;
	float sRoot = color.x - 0.0894841775 * color.y - 1.2914855480 * color.z;
	float l = lRoot * lRoot * lRoot;
	float m = mRoot * mRoot * mRoot;
	float s = sRoot * sRoot * sRoot;
	vec3 linearColor = vec3(
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
	);
	return clamp(
		vec3(
			encodeSrgb(linearColor.r),
			encodeSrgb(linearColor.g),
			encodeSrgb(linearColor.b)
		),
		0.0,
		1.0
	);
}

vec3 okLabToOkLch(vec3 color) {
	return vec3(color.x, length(color.yz), atan(color.z, color.y));
}

vec3 okLchToOkLab(vec3 color) {
	return vec3(
		color.x,
		cos(color.z) * color.y,
		sin(color.z) * color.y
	);
}

vec3 applyLightWave(vec3 okLabColor, vec2 uv) {
	vec2 point = -1.0 + 1.5 * uv;
	float x = point.x;
	float y = point.y;
	vec3 okLch = okLabToOkLch(okLabColor);
	float time = u_time * 0.2;
	float yPhase = y / 0.3;
	float xPhase = x / 0.2;
	float timeWarp = cos(sin(time) * 2.0) * 0.1;
	float movement = (x + y) * 0.001 + timeWarp + sin(x * 0.01);
	float wave1 =
		sin(yPhase + 2.0 * time + u_random.x) * 0.5 -
		yPhase -
		xPhase * 0.5;
	float wave2 = cos(
		wave1 +
			sin(movement + time) +
			sin(y * 0.025 + time) +
			sin((x + y) * 0.01) * 3.0 +
			u_random.y
	);
	float wave3 = abs(
		sin(
			wave2 +
				cos(yPhase + time + xPhase + wave2) +
				cos(xPhase) +
				sin(x * 0.001) +
				u_random.z
		)
	);
	okLch.x = clamp(okLch.x * (1.1 - 0.1 * wave3), 0.0, 1.0);
	return okLabToSrgb(okLchToOkLab(okLch));
}

float interleavedGradientNoise(vec2 position) {
	return fract(
		52.9829189 * fract(dot(position, vec2(0.06711056, 0.00583715)))
	);
}

vec3 screenSpaceDither(vec2 screenPosition) {
	vec2 position = screenPosition + u_random.xy * 97.0;
	vec3 noise = vec3(
		interleavedGradientNoise(position),
		interleavedGradientNoise(position + vec2(17.0, 59.0)),
		interleavedGradientNoise(position + vec2(71.0, 23.0))
	);
	return (noise - 0.5) / 255.0;
}

void main() {
	vec2 resolution = max(u_resolution, vec2(1.0));
	vec2 uv = gl_FragCoord.xy / resolution;
	vec2 gradientPoint = uv - 0.5;
	float seed = dot(u_random, vec3(1.0, 7.31, 13.17));
	float degree = gradientNoise(
		vec2(
			u_time * 0.1 + u_random.x * 0.07,
			gradientPoint.x * gradientPoint.y + u_random.y * 0.07
		)
	);
	float noiseAngle = ((degree - 0.5) * 720.0 + 180.0) * PI / 180.0;
	gradientPoint = rotatePoint(
		gradientPoint,
		noiseAngle + (random01(seed + 0.1) - 0.5) * 0.3
	);

	float frequency = mix(4.5, 5.5, random01(seed + 1.1));
	float amplitude = mix(22.0, 29.0, random01(seed + 2.1));
	float direction = random01(seed + 3.1) < 0.5 ? -1.0 : 1.0;
	float speed = u_time * mix(0.65, 0.85, random01(seed + 4.1)) * direction;
	gradientPoint.x += sin(gradientPoint.y * frequency + speed) / amplitude;
	gradientPoint.y +=
		sin(gradientPoint.x * frequency * 1.5 + speed) / (amplitude * 0.5);

	vec3 color1 = srgbToOkLab(u_colors[0]);
	vec3 color2 = srgbToOkLab(u_colors[1]);
	vec3 color3 = srgbToOkLab(u_colors[2]);
	vec3 color4 = srgbToOkLab(u_colors[3]);
	float rotatedX = rotatePoint(
		gradientPoint,
		(-5.0 + (random01(seed + 5.1) - 0.5) * 12.0) * PI / 180.0
	).x;
	vec3 upperLayer = mix(
		color1,
		color2,
		smoothstepRange(-0.3, 0.2, rotatedX)
	);
	vec3 lowerLayer = mix(
		color3,
		color4,
		smoothstepRange(-0.3, 0.2, rotatedX)
	);
	vec3 okLabColor = mix(
		upperLayer,
		lowerLayer,
		smoothstepRange(0.5, -0.3, gradientPoint.y)
	);
	vec3 color = u_enableLightWave
		? applyLightWave(okLabColor, uv)
		: okLabToSrgb(okLabColor);

	if (u_enableDithering) {
		color += screenSpaceDither(gl_FragCoord.xy);
	}

	gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
