// The handful of parent models nearly every block model inherits from, written out here so a scene does not need
// Minecraft's own model files to be hosted. Each one is the same shape as the game's model of that name: a full cube
// whose faces read the texture variables the child model sets. Anything else under minecraft:block/ has to be supplied
// with the scene's assets.

const FACES = ['down', 'up', 'north', 'south', 'west', 'east'];

function cube(textureFor) {
	const faces = {};
	for (const face of FACES)
		faces[face] = { texture: textureFor(face), cullface: face };
	return { elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces }] };
}

export const BUILTIN_MODELS = {
	'minecraft:block/block': {},
	'minecraft:block/thin_block': {},
	'minecraft:block/cube': cube(face => '#' + face),
	'minecraft:block/cube_all': {
		parent: 'minecraft:block/cube',
		textures: { particle: '#all', down: '#all', up: '#all', north: '#all', south: '#all', west: '#all', east: '#all' },
	},
	'minecraft:block/cube_column': {
		parent: 'minecraft:block/cube',
		textures: { particle: '#side', down: '#end', up: '#end', north: '#side', south: '#side', west: '#side', east: '#side' },
	},
	'minecraft:block/cube_bottom_top': {
		parent: 'minecraft:block/cube',
		textures: { particle: '#side', down: '#bottom', up: '#top', north: '#side', south: '#side', west: '#side', east: '#side' },
	},
	'minecraft:block/cube_top': {
		parent: 'minecraft:block/cube',
		textures: { particle: '#side', down: '#side', up: '#top', north: '#side', south: '#side', west: '#side', east: '#side' },
	},
	'minecraft:block/orientable_with_bottom': {
		parent: 'minecraft:block/cube',
		textures: { particle: '#front', down: '#bottom', up: '#top', north: '#front', south: '#side', west: '#side', east: '#side' },
	},
	'minecraft:block/orientable': {
		parent: 'minecraft:block/orientable_with_bottom',
		textures: { bottom: '#top' },
	},
};
