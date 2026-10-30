import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { AssetSource, SceneBuilder } from './scene-builder.js';

/**
 * Builds a scene and writes it as a binary glTF (.glb) with its textures inside, so a site can show the build from one
 * file with no resource pack behind it. The faces keep the game's shading as vertex colours on unlit materials
 * (KHR_materials_unlit), and the textures keep their crisp pixels (nearest filtering).
 *
 * @param {object} scene  the scene JSON (see README.md)
 * @param {string} baseUrl what the scene's asset roots are relative to (the scene file's URL)
 * @returns {Promise<ArrayBuffer>}
 */
export async function sceneToGlb(scene, baseUrl) {
	const group = await new SceneBuilder(new AssetSource(scene.assets, baseUrl), { tints: scene.tints }).build(scene);
	return new GLTFExporter().parseAsync(group, { binary: true });
}

/** Fetches the scene at {@code url} and returns it as a .glb. */
export async function sceneUrlToGlb(url) {
	const href = new URL(url, document.baseURI).href;
	const response = await fetch(href);
	if (!response.ok)
		throw new Error(`${response.status} ${href}`);
	return sceneToGlb(await response.json(), href);
}
