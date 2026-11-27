import * as THREE from 'three';

export class Particles {
  max: number;
  count = 0;
  pos: Float32Array;
  vel: Float32Array;
  col: Float32Array;
  size: Float32Array;
  baseSize: Float32Array;
  alpha: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  grav: Float32Array;
  attract: Float32Array;
  geo: THREE.BufferGeometry;
  points: THREE.Points;
  mat: THREE.ShaderMaterial;

  constructor(max: number, additive: boolean) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.baseSize = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.attract = new Float32Array(max);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('palpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 500 } },
      vertexShader: `
        attribute vec3 pcolor; attribute float psize; attribute float palpha;
        varying vec3 vC; varying float vA;
        uniform float uScale;
        void main(){
          vC = pcolor; vA = palpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, psize * uScale / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vC; varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, ${additive ? '0.0' : '0.25'}, d) * vA;
          gl_FragColor = vec4(vC, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 11 : 10;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, size: number, life: number, grav = 0, attract = 0) {
    if (this.count >= this.max) return;
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    this.size[i] = size; this.baseSize[i] = size;
    this.life[i] = life; this.maxLife[i] = life;
    this.grav[i] = grav; this.attract[i] = attract;
    this.alpha[i] = 1;
  }

  burst(x: number, y: number, z: number, n: number, speed: number, r: number, g: number, b: number, size: number, life: number, grav = 9, up = 1) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.spawn(x, y, z, Math.cos(a) * s, (0.5 + Math.random()) * speed * 0.6 * up, Math.sin(a) * s, r, g, b, size * (0.6 + Math.random() * 0.6), life * (0.6 + Math.random() * 0.6), grav);
    }
  }

  update(dt: number, tx: number, ty: number, tz: number) {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const last = --this.count;
        if (i !== last) {
          const i3 = i * 3, l3 = last * 3;
          for (let k = 0; k < 3; k++) {
            this.pos[i3 + k] = this.pos[l3 + k];
            this.vel[i3 + k] = this.vel[l3 + k];
            this.col[i3 + k] = this.col[l3 + k];
          }
          this.size[i] = this.size[last]; this.baseSize[i] = this.baseSize[last];
          this.life[i] = this.life[last]; this.maxLife[i] = this.maxLife[last];
          this.grav[i] = this.grav[last]; this.attract[i] = this.attract[last];
          this.alpha[i] = this.alpha[last];
        }
        continue;
      }
      const i3 = i * 3;
      if (this.attract[i] > 0) {
        const dx = tx - this.pos[i3], dy = ty - this.pos[i3 + 1], dz = tz - this.pos[i3 + 2];
        const a = this.attract[i] * dt;
        this.vel[i3] += dx * a; this.vel[i3 + 1] += dy * a; this.vel[i3 + 2] += dz * a;
        this.vel[i3] *= 1 - 4 * dt; this.vel[i3 + 1] *= 1 - 4 * dt; this.vel[i3 + 2] *= 1 - 4 * dt;
      } else {
        this.vel[i3] *= 1 - 1.5 * dt; this.vel[i3 + 2] *= 1 - 1.5 * dt;
      }
      this.vel[i3 + 1] -= this.grav[i] * dt;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pos[i3 + 1] < 0.03) { this.pos[i3 + 1] = 0.03; this.vel[i3 + 1] *= -0.4; }
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.min(1, t * 2.5);
      this.size[i] = this.baseSize[i] * (0.4 + 0.6 * t);
      i++;
    }
    this.geo.setDrawRange(0, this.count);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.pcolor as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.psize as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.palpha as THREE.BufferAttribute).needsUpdate = true;
  }

  clear() { this.count = 0; this.geo.setDrawRange(0, 0); }
}
