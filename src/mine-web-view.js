import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AssetSource, SceneBuilder } from './scene-builder.js';

export { AssetSource, SceneBuilder, parseBlockString } from './scene-builder.js';

/**
 * <mine-web-view src="build.glb"> or <mine-web-view src="build.json">: a Minecraft build you can turn around with the
 * mouse or a finger. A .glb (or .gltf) is shown as exported; a .json scene is built in the page from the blocks'
 * own blockstate, model and texture files (see README.md for the format).
 *
 * Attributes:
 *   src          the .glb/.gltf file or .json scene
 *   assets       asset roots for a scene, comma separated, relative to the page (overrides the scene's own "assets")
 *   auto-rotate  turn slowly until the viewer is touched
 *   background   a CSS colour behind the build (transparent by default)
 *   zoom         camera distance: 1 (the default) just fits the build, more is further away
 */
export class MineWebView extends HTMLElement {
	static observedAttributes = ['src', 'assets', 'background', 'auto-rotate'];

	#renderer;
	#scene;
	#camera;
	#controls;
	#content;
	#frame = 0;
	#observer;
	#loadToken = 0;
	#status;

	connectedCallback() {
		if (this.#renderer)
			return;
		const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' }); // Kept if it is moved in the page.
		root.innerHTML = `
			<style>
				:host { display: block; position: relative; width: 100%; aspect-ratio: 4 / 3; touch-action: none; }
				canvas { display: block; width: 100%; height: 100%; outline: none; cursor: grab; }
				canvas:active { cursor: grabbing; }
				.status { position: absolute; inset: 0; display: grid; place-items: center; font: 14px system-ui, sans-serif;
					color: var(--mine-web-view-status, #888); pointer-events: none; }
				.status:empty { display: none; }
			</style>
			<div class="status">Loading…</div>`;
		this.#status = root.querySelector('.status');

		this.#renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
		root.prepend(this.#renderer.domElement);

		this.#scene = new THREE.Scene();
		this.#scene.add(new THREE.AmbientLight(0xffffff, 1.6)); // For lit .glb materials; scenes use unlit ones.
		const sun = new THREE.DirectionalLight(0xffffff, 1.4);
		sun.position.set(3, 5, 2);
		this.#scene.add(sun);
		this.#camera = new THREE.PerspectiveCamera(35, 4 / 3, 0.05, 1000);
		this.#controls = new OrbitControls(this.#camera, this.#renderer.domElement);
		this.#controls.enableDamping = true;
		this.#controls.addEventListener('start', () => { this.#controls.autoRotate = false; });

		this.#observer = new ResizeObserver(() => this.#resize());
		this.#observer.observe(this);
		this.#applyBackground();
		this.#controls.autoRotate = this.hasAttribute('auto-rotate');
		this.#animate();
		this.#load();
	}

	disconnectedCallback() {
		cancelAnimationFrame(this.#frame);
		this.#observer?.disconnect();
		this.#controls?.dispose();
		this.#renderer?.dispose();
		this.#renderer = null;
		this.shadowRoot && (this.shadowRoot.innerHTML = '');
	}

	attributeChangedCallback(name) {
		if (!this.#renderer)
			return;
		if (name === 'background')
			this.#applyBackground();
		else if (name === 'auto-rotate')
			this.#controls.autoRotate = this.hasAttribute('auto-rotate');
		else
			this.#load();
	}

	#applyBackground() {
		const background = this.getAttribute('background');
		this.#renderer.setClearColor(background ? new THREE.Color(background) : 0x000000, background ? 1 : 0);
	}

	#resize() {
		const width = this.clientWidth, height = this.clientHeight;
		if (!width || !height)
			return;
		this.#renderer.setSize(width, height, false);
		this.#camera.aspect = width / height;
		this.#camera.updateProjectionMatrix();
	}

	#animate() {
		this.#frame = requestAnimationFrame(() => this.#animate());
		this.#controls.update();
		this.#renderer.render(this.#scene, this.#camera);
	}

	async #load() {
		const src = this.getAttribute('src');
		if (!src)
			return;
		const token = ++this.#loadToken;
		this.#status.textContent = 'Loading…';
		try {
			const url = new URL(src, document.baseURI);
			let content;
			if (/\.(glb|gltf)$/i.test(url.pathname))
				content = (await new GLTFLoader().loadAsync(url.href)).scene;
			else {
				const response = await fetch(url);
				if (!response.ok)
					throw new Error(`${response.status} ${url}`);
				const scene = await response.json();
				const roots = this.getAttribute('assets')?.split(',').map(s => s.trim()) ?? scene.assets;
				// Asset roots in the attribute are relative to the page, in the scene file to the scene.
				const assets = new AssetSource(roots, this.hasAttribute('assets') ? document.baseURI : url.href);
				content = await new SceneBuilder(assets, { tints: scene.tints }).build(scene);
			}
			if (token !== this.#loadToken)
				return;
			if (this.#content)
				this.#scene.remove(this.#content);
			this.#content = content;
			this.#scene.add(content);
			this.#frameCamera();
			this.#status.textContent = '';
			this.dispatchEvent(new CustomEvent('load'));
		}
		catch (error) {
			console.error('[MineWebView]', error);
			this.#status.textContent = 'Could not load this build.';
			this.dispatchEvent(new CustomEvent('error', { detail: error }));
		}
	}

	/** Points the camera at the build from the south-east, a little above, just far enough to see all of it. */
	#frameCamera() {
		const sphere = new THREE.Box3().setFromObject(this.#content).getBoundingSphere(new THREE.Sphere());
		const radius = sphere.radius || 1;
		const zoom = Number(this.getAttribute('zoom')) || 1.0;
		// Fit the sphere in the narrower of the two fields of view.
		const vertical = THREE.MathUtils.degToRad(this.#camera.fov) / 2;
		const horizontal = Math.atan(Math.tan(vertical) * this.#camera.aspect);
		const distance = radius / Math.sin(Math.min(vertical, horizontal)) * zoom;
		const direction = new THREE.Vector3(1, 0.8, 1.2).normalize();
		this.#camera.position.copy(sphere.center).addScaledVector(direction, distance);
		this.#camera.near = radius / 50;
		this.#camera.far = distance + radius * 20;
		this.#camera.updateProjectionMatrix();
		this.#controls.target.copy(sphere.center);
		this.#controls.minDistance = radius * 0.5;
		this.#controls.maxDistance = distance * 3;
		this.#controls.update();
	}
}

if (!customElements.get('mine-web-view'))
	customElements.define('mine-web-view', MineWebView);
