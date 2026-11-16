/**
 * A broadcast microphone on a sprung boom arm, drawn with 2D signed distances
 * in design units (frame heights), shared by the Scenes that have one (Radio
 * Studio, Just Chatting Corner).
 *
 * `BOOM_MIC_GLSL` defines
 * `void boomMic(vec2 f, vec2 a0, vec2 a1, vec2 a2, vec2 m, vec2 mh, vec2 cableEnd)`:
 * the arm from its mount `a0` through the elbow `a1` to its tip `a2`, the foam
 * windscreen centred on `m` with half size `mh`, the body and shock mount below
 * it, a cable sagging from the body to `cableEnd`, and their shadow on the wall
 * down and to the right. The yoke reaches the cage from its right, so the tip
 * should be to the right of the microphone (mirror the point to flip it), and
 * everything should lie between the mount's and the tip's x, give or take
 * 0.03: nothing is drawn outside that.
 *
 * The host shader provides, before it: `SDF2D_GLSL` and `HASH32_GLSL`, a global
 * `vec3 col` (the colour so far, which the shadow darkens), and
 * `void micLay(vec3 c, float a, float recv)`, which paints a matte surface of
 * colour `c` over `col` at coverage `a`, lit by the host's light, `recv` being
 * how much of the room's spill light reaches it.
 */

/** GLSL for `boomMic` (see the module comment for what it needs). */
export const BOOM_MIC_GLSL = /* glsl */ `
const vec3 MIC_METAL = vec3(0.6, 0.61, 0.63);
float micRand(vec2 cell) {
  uvec2 u = uvec2(ivec2(cell) + 65536);
  return float(hash32(u.x * 0x9e3779b1u ^ hash32(u.y ^ 29u))) / 4294967296.0;
}
void boomMic(vec2 f, vec2 a0, vec2 a1, vec2 a2, vec2 m, vec2 mh, vec2 cableEnd) {
  // Nothing of it (or its shadow) reaches past these.
  float lo = min(a0.x, a2.x);
  float hi = max(a0.x, a2.x);
  if (f.x < lo - 0.03 || f.x > hi + 0.03) {
    return;
  }
  vec2 bodyC = vec2(m.x, m.y - mh.y - 0.045);
  vec2 bodyH = vec2(0.022, 0.06);
  // Shadows on the wall, down and to the right.
  vec2 s = f - vec2(0.012, -0.02);
  float sd = min(sdSeg(s, a0, a1), sdSeg(s, a1, a2)) - 0.006;
  sd = min(sd, sdBox(s - m, mh, mh.x));
  sd = min(sd, sdBox(s - bodyC, bodyH + vec2(0.02, 0.0), 0.02));
  col *= 1.0 - 0.35 * (1.0 - smoothstep(-0.004, 0.02, sd));
  // The cable, sagging down to the desk.
  vec2 c0 = bodyC - vec2(0.0, bodyH.y);
  vec2 c2 = cableEnd;
  vec2 c1 = vec2(m.x + 0.02, 0.5 * (c0.y + c2.y) - 0.05);
  float cd = 1e3;
  vec2 prev = c0;
  for (int i = 1; i <= 6; i++) {
    float t = float(i) / 6.0;
    vec2 p = mix(mix(c0, c1, t), mix(c1, c2, t), t);
    cd = min(cd, sdSeg(f, prev, p));
    prev = p;
  }
  micLay(vec3(0.03), cover(cd - 0.0028), 0.3);
  // The arm: two tubes with springs alongside, and the elbow.
  for (int i = 0; i < 2; i++) {
    vec2 p0 = i == 0 ? a0 : a1;
    vec2 p1 = i == 0 ? a1 : a2;
    vec2 dir = normalize(p1 - p0);
    vec2 n = vec2(-dir.y, dir.x);
    float along = dot(f - p0, dir);
    float acr = dot(f - p0, n);
    float tube = sdSeg(f, p0, p1) - 0.0048;
    vec3 tc = vec3(0.05) + vec3(0.18) * smoothstep(0.0048, 0.0, abs(acr - 0.0015)) * 0.6;
    micLay(tc, cover(tube), 0.4);
    float len = length(p1 - p0);
    vec2 s0 = p0 + dir * len * 0.2 + n * 0.0115;
    vec2 s1 = p0 + dir * len * 0.7 + n * 0.0115;
    float spring = sdSeg(f, s0, s1) - 0.0034;
    vec3 sc = MIC_METAL * (0.35 + 0.55 * pow(0.5 + 0.5 * sin(along * TAU / 0.0042), 2.0));
    micLay(sc, cover(spring), 0.4);
    float link = min(sdSeg(f, s0, s0 - n * 0.0115), sdSeg(f, s1, s1 - n * 0.0115)) - 0.0012;
    micLay(MIC_METAL * 0.5, cover(link), 0.4);
  }
  micLay(vec3(0.07), cover(length(f - a1) - 0.011), 0.4);
  micLay(MIC_METAL * 0.55, cover(length(f - a1) - 0.004), 0.4);
  // The shock mount: a cage round the body, hung on elastic cords.
  vec2 bq = f - bodyC;
  float cage = min(sdBox(vec2(bq.x, abs(bq.y) - 0.03), vec2(0.045, 0.0028), 0.0015), sdBox(vec2(abs(bq.x) - 0.045, bq.y), vec2(0.0028, 0.033), 0.0015));
  float cords = 1e3;
  for (int i = -1; i <= 1; i += 2) {
    for (int j = -1; j <= 1; j += 2) {
      cords = min(cords, sdSeg(bq, vec2(float(i) * 0.045, float(j) * 0.03), vec2(float(i) * 0.02, float(-j) * 0.012)));
    }
  }
  // The yoke from the arm's tip to the cage.
  float yoke = sdSeg(f, a2, bodyC + vec2(0.045, 0.0)) - 0.003;
  micLay(vec3(0.07), cover(min(cage, yoke)), 0.4);
  micLay(vec3(0.02), cover(cords - 0.001), 0.3);
  // The body: a dark metal cylinder with a bright band.
  float bd = sdBox(bq, bodyH, 0.012);
  float cyl = bq.x / bodyH.x;
  vec3 body = vec3(0.12, 0.12, 0.13) * (0.55 + 0.6 * sqrt(max(0.0, 1.0 - cyl * cyl)) * smoothstep(1.0, -0.6, cyl));
  body = mix(body, MIC_METAL * (0.6 + 0.4 * smoothstep(0.6, -0.4, cyl)), step(abs(bq.y - bodyH.y + 0.012), 0.004));
  micLay(body, cover(bd), 0.3);
  micLay(vec3(0.02), cover(cords - 0.001) * step(abs(bq.x), bodyH.x), 0.3);
  // The foam windscreen on top.
  vec2 wq = f - m;
  float wd = sdBox(wq, mh, mh.x);
  float wx = wq.x / mh.x;
  float stip = 0.85 + 0.3 * micRand(floor(f * 520.0));
  vec3 wind = vec3(0.075, 0.075, 0.08) * stip * (0.5 + 0.75 * sqrt(max(0.0, 1.0 - wx * wx)) * smoothstep(1.1, -0.7, wx));
  wind *= 0.8 + 0.3 * smoothstep(-mh.y, mh.y, wq.y);
  micLay(wind, cover(wd), 0.5);
}
`;
