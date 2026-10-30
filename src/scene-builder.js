import * as THREE from 'three';
import { BUILTIN_MODELS } from './builtin-models.js';

/*
 * Builds a three.js group from a scene: a list of blocks, each a block id and state (looked up in that block's
 * blockstate file) or a model straight away, placed on a grid. Models are Minecraft's JSON block models: parents,
 * texture variables, elements with per-face UVs and rotation, element rotation, and the blockstate's x/y rotation.
 * Faces are shaded the way the game shades them (top brightest, bottom darkest) with unlit materials, so the result
 * looks like the game rather than like a lit 3D scene.
 */

const FACE_SHADE = { up: 1.0, down: 0.5, north: 0.8, south: 0.8, west: 0.6, east: 0.6 };
const OPPOSITE = { up: 'down', down: 'up', north: 'south', south: 'north', west: 'east', east: 'west' };
const STEP = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };

/** Splits "ns:path" (no namespace means minecraft). */
export function splitId(id) {
	const i = id.indexOf(':');
	return i < 0 ? ['minecraft', id] : [id.slice(0, i), id.slice(i + 1)];
}

function fullId(id) {
	const [ns, path] = splitId(id);
	return ns + ':' + path;
}

/** "radiocraft:wire[east=true,west=true]" as a block id and a state object. */
export function parseBlockString(text) {
	const m = /^([^[\]]+)(?:\[(.*)\])?$/.exec(text.trim());
	if (!m)
		throw new Error('Not a block: ' + text);
	const state = {};
	if (m[2])
		for (const pair of m[2].split(',')) {
			const [key, value] = pair.split('=');
			state[key.trim()] = value.trim();
		}
	return { block: fullId(m[1]), state };
}

/**
 * Fetches a scene's resource files: blockstates, models and textures under one or more asset roots laid out as a
 * resource pack's assets folder (root/namespace/blockstates/..., root/namespace/models/..., root/namespace/textures/...).
 * Roots are tried in order; each answer is kept.
 */
export class AssetSource {
	constructor(roots, baseUrl) {
		this.roots = (Array.isArray(roots) ? roots : [roots ?? 'assets/']).map(root => new URL(root.endsWith('/') ? root : root + '/', baseUrl).href);
		this.json = new Map();
		this.images = new Map();
	}

	async #first(relative, load) {
		for (const root of this.roots) {
			try {
				const result = await load(root + relative);
				if (result !== undefined)
					return result;
			}
			catch { /* Try the next root. */ }
		}
		return undefined;
	}

	/** The JSON at ns:type/path.json, or undefined if no root has it. */
	getJson(type, id) {
		const [ns, path] = splitId(id);
		const key = `${ns}/${type}/${path}.json`;
		if (!this.json.has(key))
			this.json.set(key, this.#first(key, async url => {
				const response = await fetch(url);
				return response.ok ? response.json() : undefined;
			}));
		return this.json.get(key);
	}

	/** The texture ns:textures/path.png as an HTMLImageElement, or undefined. */
	getImage(id) {
		const [ns, path] = splitId(id);
		const key = `${ns}/textures/${path}.png`;
		if (!this.images.has(key))
			this.images.set(key, this.#first(key, url => new Promise(resolve => {
				const image = new Image();
				image.crossOrigin = 'anonymous';
				image.onload = () => resolve(image);
				image.onerror = () => resolve(undefined);
				image.src = url;
			})));
		return this.images.get(key);
	}
}

/** A loaded model with its parents merged: elements and resolved texture variables. */
async function resolveModel(assets, id, seen = new Set()) {
	id = fullId(id);
	if (seen.has(id))
		return { textures: {}, elements: null };
	seen.add(id);
	const own = BUILTIN_MODELS[id] ?? await assets.getJson('models', id);
	if (!own) {
		console.warn('[MineWebView] missing model', id);
		return { textures: {}, elements: null, missing: true };
	}
	const parent = own.parent ? await resolveModel(assets, own.parent, seen) : { textures: {}, elements: null };
	return {
		loader: own.loader ?? parent.loader,
		raw: own,
		textures: { ...parent.textures, ...(own.textures ?? {}) },
		elements: own.elements ?? parent.elements,
		missing: parent.missing && !own.elements,
	};
}

/** Follows "#var" references to a texture id, or undefined. */
function resolveTexture(textures, ref) {
	for (let i = 0; i < 16 && ref && ref.startsWith('#'); i++)
		ref = textures[ref.slice(1)];
	return ref && !ref.startsWith('#') ? fullId(ref) : undefined;
}

/**
 * True if every "key=value" condition (values may be "a|b") holds for the state. With {@code lenient}, a property the
 * state does not give matches anything: the scene left it at the block's default, which only the game knows (a guide
 * build says facing=north and leaves out ceiling=false). Blockstate variants are matched leniently, the first that
 * fits winning; multipart conditions strictly, so a wire's missing side stays off.
 */
function matches(condition, state, lenient = false) {
	if (condition.OR)
		return condition.OR.some(c => matches(c, state, lenient));
	if (condition.AND)
		return condition.AND.every(c => matches(c, state, lenient));
	return Object.entries(condition).every(([key, value]) =>
		(lenient && state[key] === undefined) || String(value).split('|').includes(String(state[key])));
}

/** The models (with x/y rotation) a block in a state is drawn with, from its blockstate file. */
async function modelsForState(assets, block, state) {
	const blockstate = await assets.getJson('blockstates', block);
	if (!blockstate) {
		console.warn('[MineWebView] missing blockstate', block);
		return [];
	}
	const pick = apply => Array.isArray(apply) ? apply[0] : apply; // Weighted alternatives: always the first.
	if (blockstate.variants) {
		for (const [key, apply] of Object.entries(blockstate.variants)) {
			const condition = {};
			if (key !== '' && key !== 'normal')
				for (const pair of key.split(',')) {
					const [k, v] = pair.split('=');
					condition[k] = v;
				}
			if (matches(condition, state, true))
				return [pick(apply)];
		}
		console.warn('[MineWebView] no variant of', block, 'matches', state);
		return [];
	}
	if (blockstate.multipart)
		return blockstate.multipart.filter(part => !part.when || matches(part.when, state)).map(part => pick(part.apply));
	return [];
}

/** The four corners of a face, top-left first, as the game maps UVs onto them (0-16 model units). */
function faceCorners(face, [x1, y1, z1], [x2, y2, z2]) {
	switch (face) {
		case 'north': return [[x2, y2, z1], [x1, y2, z1], [x1, y1, z1], [x2, y1, z1]];
		case 'south': return [[x1, y2, z2], [x2, y2, z2], [x2, y1, z2], [x1, y1, z2]];
		case 'west': return [[x1, y2, z1], [x1, y2, z2], [x1, y1, z2], [x1, y1, z1]];
		case 'east': return [[x2, y2, z2], [x2, y2, z1], [x2, y1, z1], [x2, y1, z2]];
		case 'up': return [[x1, y2, z1], [x2, y2, z1], [x2, y2, z2], [x1, y2, z2]];
		case 'down': return [[x1, y1, z2], [x2, y1, z2], [x2, y1, z1], [x1, y1, z1]];
	}
	return null;
}

/** The UV rectangle the game uses for a face with none given. */
function defaultUv(face, [x1, y1, z1], [x2, y2, z2]) {
	switch (face) {
		case 'down': return [x1, 16 - z2, x2, 16 - z1];
		case 'up': return [x1, z1, x2, z2];
		case 'north': return [16 - x2, 16 - y2, 16 - x1, 16 - y1];
		case 'south': return [x1, 16 - y2, x2, 16 - y1];
		case 'west': return [z1, 16 - y2, z2, 16 - y1];
		case 'east': return [16 - z2, 16 - y2, 16 - z1, 16 - y1];
	}
	return [0, 0, 16, 16];
}

/** Rotates a point (model units) about an element's rotation origin, with the game's rescale. */
function elementTransform(rotation) {
	if (!rotation || !rotation.angle)
		return p => p;
	const angle = THREE.MathUtils.degToRad(rotation.angle);
	const axis = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[rotation.axis];
	const origin = new THREE.Vector3(...(rotation.origin ?? [8, 8, 8]));
	const scale = new THREE.Vector3(1, 1, 1);
	if (rotation.rescale) {
		const s = 1 / Math.cos(Math.abs(angle));
		if (rotation.axis !== 'x') scale.x = s;
		if (rotation.axis !== 'y') scale.y = s;
		if (rotation.axis !== 'z') scale.z = s;
	}
	const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
	return p => {
		const v = new THREE.Vector3(...p).sub(origin).applyQuaternion(q).multiply(scale).add(origin);
		return [v.x, v.y, v.z];
	};
}

/** The direction a face points after the blockstate's x then y rotation (for culling against neighbours). */
function rotateFace(face, x, y) {
	const v = new THREE.Vector3(...STEP[face]);
	v.applyAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(-x));
	v.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(-y));
	for (const [name, step] of Object.entries(STEP))
		if (Math.round(v.x) === step[0] && Math.round(v.y) === step[1] && Math.round(v.z) === step[2])
			return name;
	return face;
}

/**
 * Wires strung between blocks ({@code scene.wires}: { from: [x, y, z], to: [x, y, z], color, width, anchor }), drawn
 * as the game draws a leash and RadioCraft its antenna wire: two thin crossed ribbons in bands of two shades, three
 * steps a block, straight between ends at one height and curving (low end first) between ends at two. The ends are
 * block positions; the wire is held at {@code anchor} inside each (the middle by default).
 */
export function wireMesh(wires) {
	const positions = [], colors = [], indices = [];
	for (const wire of wires) {
		const anchor = wire.anchor ?? [0.5, 0.5, 0.5];
		const from = new THREE.Vector3(...wire.from).add(new THREE.Vector3(...anchor));
		const to = new THREE.Vector3(...wire.to).add(new THREE.Vector3(...anchor));
		const d = new THREE.Vector3().subVectors(to, from);
		const width = wire.width ?? 0.04;
		const flat = Math.hypot(d.x, d.z) || 1;
		const side = new THREE.Vector3(d.z / flat, 0, -d.x / flat).multiplyScalar(width / 2); // Across the wire.
		const steps = Math.max(1, Math.round(d.length()) * 3);
		const base = new THREE.Color(wire.color ?? '#666666');
		// The game's curve: y = dy f^2 rising, dy - dy (1 - f)^2 falling.
		const point = f => new THREE.Vector3(from.x + d.x * f,
			from.y + (d.y > 0 ? d.y * f * f : d.y - d.y * (1 - f) * (1 - f)), from.z + d.z * f);
		for (const lift of [width, 0]) { // The two ribbons: one rising across the wire, one falling.
			for (let i = 0; i < steps; i++) {
				const shade = i % 2 === (lift ? 0 : 1) ? 0.7 : 1.0;
				const c = base.clone().multiplyScalar(shade);
				const start = positions.length / 3;
				for (const f of [i / steps, (i + 1) / steps]) {
					const p = point(f);
					positions.push(p.x - side.x, p.y + lift, p.z - side.z, p.x + side.x, p.y + width - lift, p.z + side.z);
					colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
				}
				indices.push(start, start + 1, start + 3, start, start + 3, start + 2);
			}
		}
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
	geometry.setIndex(indices);
	const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
	mesh.name = 'wires';
	return mesh;
}

/** A checkerboard for textures that could not be found, as the game draws them. */
function missingTexture() {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 16;
	const g = canvas.getContext('2d');
	g.fillStyle = '#000';
	g.fillRect(0, 0, 16, 16);
	g.fillStyle = '#f800f8';
	g.fillRect(0, 0, 8, 8);
	g.fillRect(8, 8, 8, 8);
	return canvas;
}

/**
 * Builds scenes. Mods with custom model loaders (models drawn from parts depending on their neighbours, say) register
 * a function per loader id with {@link SceneBuilder.registerLoader}: it gets { block, state, model, x, y, blockAt },
 * where model is the raw model JSON (with the loader's own fields) and blockAt(dx, dy, dz) the scene entry next to it
 * ({ block, state } or undefined), and returns the part models to draw instead, as [{ model, x, y }].
 */
export class SceneBuilder {
	static loaders = new Map();

	static registerLoader(id, handler) {
		SceneBuilder.loaders.set(fullId(id), handler);
	}

	constructor(assets, options = {}) {
		this.assets = assets;
		this.tints = { default: '#7fb238', ...(options.tints ?? {}) };
		this.materials = new Map();
	}

	async #material(textureId) {
		if (this.materials.has(textureId))
			return this.materials.get(textureId);
		const promise = (async () => {
			const image = textureId ? await this.assets.getImage(textureId) : undefined;
			if (textureId && !image)
				console.warn('[MineWebView] missing texture', textureId);
			const source = image ?? missingTexture();
			const texture = new THREE.Texture(source);
			texture.magFilter = THREE.NearestFilter;
			texture.minFilter = THREE.NearestFilter;
			texture.generateMipmaps = false;
			texture.colorSpace = THREE.SRGBColorSpace;
			texture.needsUpdate = true;
			// An animated texture is a strip of square frames: show the first.
			const frames = source.height > source.width ? source.height / source.width : 1;
			const material = new THREE.MeshBasicMaterial({ map: texture, vertexColors: true, alphaTest: 0.1, side: THREE.FrontSide });
			return { material, frames };
		})();
		this.materials.set(textureId, promise);
		return promise;
	}

	/** The models to draw for one scene entry, after blockstates and custom loaders. */
	async #partsFor(entry, blockAt) {
		const parts = [];
		const queue = entry.model
			? [{ model: entry.model, x: entry.x ?? 0, y: entry.y ?? 0 }]
			: (await modelsForState(this.assets, entry.block, entry.state ?? {})).map(a => ({ model: a.model, x: a.x ?? 0, y: a.y ?? 0 }));
		for (const part of queue) {
			const model = await resolveModel(this.assets, part.model);
			const loader = model.loader && SceneBuilder.loaders.get(fullId(model.loader));
			if (loader) {
				const [px, py, pz] = entry.pos;
				const replaced = await loader({ block: entry.block, state: entry.state ?? {}, model: model.raw, x: part.x, y: part.y,
					blockAt: (dx, dy, dz) => blockAt(px + dx, py + dy, pz + dz) });
				for (const sub of replaced ?? [])
					parts.push({ model: await resolveModel(this.assets, sub.model), x: sub.x ?? 0, y: sub.y ?? 0 });
			}
			else
				parts.push({ model, x: part.x, y: part.y });
		}
		return parts;
	}

	/**
	 * Builds the scene's group: one mesh per texture. {@code scene.blocks} entries are { pos: [x, y, z], block, state }
	 * or { pos, model, x, y }, or { from, to, block | model } to fill a box; a block may also be given as
	 * "ns:id[key=value,...]".
	 */
	async build(scene) {
		const entries = [];
		for (const raw of scene.blocks ?? []) {
			const entry = { ...raw };
			if (typeof entry.block === 'string' && entry.block.includes('[')) {
				const parsed = parseBlockString(entry.block);
				entry.block = parsed.block;
				entry.state = { ...parsed.state, ...(entry.state ?? {}) };
			}
			else if (entry.block)
				entry.block = fullId(entry.block);
			if (entry.from && entry.to) {
				const [a, b] = [entry.from, entry.to];
				for (let x = Math.min(a[0], b[0]); x <= Math.max(a[0], b[0]); x++)
					for (let y = Math.min(a[1], b[1]); y <= Math.max(a[1], b[1]); y++)
						for (let z = Math.min(a[2], b[2]); z <= Math.max(a[2], b[2]); z++)
							entries.push({ ...entry, pos: [x, y, z] });
			}
			else
				entries.push(entry);
		}

		const grid = new Map(entries.map(entry => [entry.pos.join(','), entry]));
		const blockAt = (x, y, z) => grid.get([x, y, z].join(','));
		// Full cubes, to hide faces against them (cullface), as the game does.
		const resolved = await Promise.all(entries.map(async entry => ({ entry, parts: await this.#partsFor(entry, blockAt) })));
		const solid = new Set();
		for (const { entry, parts } of resolved)
			if (parts.some(p => (p.model.elements ?? []).some(e => e.from.every(v => v === 0) && e.to.every(v => v === 16) && !e.rotation)))
				solid.add(entry.pos.join(','));

		const buckets = new Map(); // texture id -> { positions, uvs, colors, indices }
		for (const { entry, parts } of resolved)
			for (const part of parts)
				await this.#addModel(buckets, entry, part, solid);

		const group = new THREE.Group();
		if (scene.wires?.length)
			group.add(wireMesh(scene.wires));
		for (const [textureId, data] of buckets) {
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
			geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
			geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.colors, 3));
			geometry.setIndex(data.indices);
			const { material } = await this.#material(textureId);
			group.add(new THREE.Mesh(geometry, material));
		}
		return group;
	}

	async #addModel(buckets, entry, part, solid) {
		const { model, x: rx, y: ry } = part;
		if (!model.elements)
			return;
		const [bx, by, bz] = entry.pos;
		const blockRotation = new THREE.Matrix4()
			.makeTranslation(8, 8, 8)
			.multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(-ry)))
			.multiply(new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(-rx)))
			.multiply(new THREE.Matrix4().makeTranslation(-8, -8, -8));
		const tint = new THREE.Color(this.tints[entry.tint] ?? entry.tint ?? this.tints.default);

		for (const element of model.elements) {
			const transform = elementTransform(element.rotation);
			for (const [face, spec] of Object.entries(element.faces ?? {})) {
				if (spec.cullface) {
					const out = STEP[rotateFace(spec.cullface, rx, ry)];
					if (solid.has([bx + out[0], by + out[1], bz + out[2]].join(',')))
						continue;
				}
				const corners = faceCorners(face, element.from, element.to);
				if (!corners)
					continue;
				const textureId = resolveTexture(model.textures, spec.texture);
				const { frames } = await this.#material(textureId ?? null);
				const key = textureId ?? null;
				if (!buckets.has(key))
					buckets.set(key, { positions: [], uvs: [], colors: [], indices: [] });
				const bucket = buckets.get(key);

				const [u1, v1, u2, v2] = spec.uv ?? defaultUv(face, element.from, element.to);
				const uvCorners = [[u1, v1], [u2, v1], [u2, v2], [u1, v2]];
				const turn = ((spec.rotation ?? 0) / 90) & 3;
				const facing = rotateFace(face, rx, ry);
				const shade = element.shade === false ? 1.0 : FACE_SHADE[facing];
				const color = spec.tintindex !== undefined && spec.tintindex >= 0 ? tint.clone().multiplyScalar(shade) : new THREE.Color(shade, shade, shade);

				const base = bucket.positions.length / 3;
				for (let i = 0; i < 4; i++) {
					const v = new THREE.Vector3(...transform(corners[i])).applyMatrix4(blockRotation);
					bucket.positions.push(bx + v.x / 16, by + v.y / 16, bz + v.z / 16);
					const [u, w] = uvCorners[(i - turn + 4) % 4];
					bucket.uvs.push(u / 16, 1 - (w / 16) / frames);
					bucket.colors.push(color.r, color.g, color.b);
				}
				bucket.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
			}
		}
	}
}
