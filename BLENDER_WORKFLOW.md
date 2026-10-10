# Bringing Blender art into Cartbox

Cartbox's editor is not a modelling tool. Characters, weapons and props come
from Blender (or any tool that writes glTF 2.0), and the editor's **Import 3D
model** button takes them in one step (HALO_INFINITE_STYLE_ROADMAP.md, I13). This page
covers how to set up a model so that step brings in everything: the mesh, its
skeleton and animations, its PBR maps and its material sets.

## What one import brings

Pick a `.glb` with the Mesh tab's **Import 3D model** button. The editor then:

- **Reads the mesh**, with every object's transform baked in. Each material on
  a mesh becomes its own primitive.
- **Reads the skeleton** (the first armature a mesh is skinned to) and every
  action on it as an **animation clip**.
- **Adds a state machine** to start from, with one looping state per clip.
  Edit it in the Animator panel.
- **Reads the PBR maps:**
  - base colour
  - normal
  - metallic-roughness
  - occlusion
  - emission
  - the clearcoat and anisotropy factors
- **Keeps a packed occlusion/roughness/metal (ORM) map as one image.** It
  fills both of its slots, so it is stored, downloaded and decoded only once.
- **Reads the material sets** (`KHR_materials_variants`). Each placed copy of
  the model can wear any of them, chosen in the object's **Material set** box.
- **Compresses the maps to KTX2** (Basis Universal). See
  [Compressed textures](#compressed-textures).
- **Makes distance LODs** for a heavy model.

The note under the viewport says what came in, for example: "With a 24-joint
skeleton with 9 clips and a state machine, 2 material sets, packed
occlusion/roughness/metal maps."

## Exporting from Blender

Use **File › Export › glTF 2.0** with these settings:

| Setting | Value | Why |
| --- | --- | --- |
| Format | **glTF Binary (.glb)** | One self-contained file. A `.gltf` with separate `.bin` or image files can't be read; a `.gltf` with everything embedded can. |
| Include › Limit to | Selected objects (optional) | Export just the asset, not the scene around it. |
| Transform › +Y Up | **On** | Cartbox is Y-up, like glTF. |
| Data › Mesh › Apply Modifiers | **On** | What you see is what you get. |
| Data › Mesh › UVs, Normals | **On** | The first UV map is used for every texture. |
| Data › Material › Materials | **Export** | |
| Data › Material › Images | **Automatic** | PNG for maps with alpha or flat colour, JPEG for photos; either is re-encoded to KTX2 on import. |
| Data › Shape Keys | Off | Morph targets aren't read. |
| Data › Armature › Use Rest Position | **On** | |
| Data › Skinning › Include All Bone Influences | **Off** | Four influences per vertex are read; extra ones are dropped. |
| Animation › Mode | **Actions** (or **NLA Tracks**) | Each action (or track) becomes one named clip. |
| Animation › Sampling Animations | **On** | Constraints and IK are baked into keys. Cubic-spline keys become linear, and stepped keys stay stepped. |
| Compression | Off, or Draco or meshopt | Both are decoded on import. |

## Skeletons and animation

- Skin the mesh to **one armature**. Only the first skin is read, up to **256
  joints**.
- Name actions for what they are (`idle`, `run`, `fire`, `melee`, `die`). Clip
  names become the state names in the generated state machine, and they are
  what the cart's Lua plays and triggers.
- Up to **64 clips** and **500,000 keys** in all. Only bone rotation,
  location and scale are read, so object-level animation of the armature is
  dropped.
- A rigid prop parented to a bone (a sword in a hand) is bound to that bone
  and moves with it.

## Materials and texture conventions

Build materials from the **Principled BSDF**. The exporter writes what
Cartbox reads:

| Principled input | Texture | Colour space | Read as |
| --- | --- | --- | --- |
| Base Color | albedo, alpha in A if used | **sRGB** | base colour, and transparency (Alpha Clip → `mask`, Alpha Blend → `blend`) |
| Metallic and Roughness | one image through *Separate Color*: **G = roughness, B = metal** | **Non-Color** | metallic-roughness |
| (glTF Material Output) Occlusion | **R = ambient occlusion** | **Non-Color** | occlusion |
| Normal (via a *Normal Map* node) | tangent-space, OpenGL (+Y) | **Non-Color** | normal |
| Emission Color and Strength | emissive colour | **sRGB** | emission |
| Coat Weight and Roughness | factors only | — | clearcoat (I4) |
| Anisotropic and Rotation | factors only | — | anisotropy (I4) |

**Pack occlusion, roughness and metal into one ORM image:** R = occlusion,
G = roughness, B = metal. Wire it to Metallic and Roughness through *Separate
Color*, and wire its R to the glTF Material Output's Occlusion. Most texture
painters (Substance Painter's "glTF PBR Metal Roughness" preset, Quixel and
others) export this layout directly. The exporter writes one image for both
slots, and Cartbox keeps it as one.

Keep textures at power-of-two sizes, at most 4096 × 2048. Larger ones import,
but they are kept as PNG or JPEG instead of being compressed.

**Team colours:** after import, tick **Takes the team colour** in the
Material panel for the parts a team should paint. Use the share slider for
trim that should take only a hint of it.

## Material sets (variants)

Blender's glTF exporter writes `KHR_materials_variants`. In the 3D
viewport's sidebar, under **glTF Variants**:

1. Add a variant for each set (for example "Veteran" and "Recon").
2. Assign each object's alternative material slot to the variants that use it.
3. Export as above, with the exporter's material variants option on (under
   **Data › Material** in recent versions).

On import, each set lists the material it puts on each part. A part a set
doesn't mention keeps its own material, and a set that changes nothing is
dropped. Up to **16 sets** per model. Each placed copy picks its set in the
object's **Material set** box, and the player draws it in that set's
materials. Its distance LODs and team colour follow.

## Compressed textures

On import, every PNG or JPEG map is encoded to **KTX2** (Basis Universal),
in the editor:

- **Colour maps** (base colour, emission) are encoded as **ETC1S**, the
  smallest form, in sRGB.
- **Normal and data maps** (normal, ORM) are encoded as **UASTC**, which is
  near-lossless, with rate-distortion optimisation and Zstandard
  supercompression, in linear space.

The KTX2 form is kept when it travels lighter (gzipped). If the scene has no
KTX2 textures yet, the saving must also cover the transcoder players then
fetch, about 250 KB. A small prop therefore keeps its PNG, and a fully
textured character becomes KTX2. Textures that arrive already as KTX2
(`KHR_texture_basisu`) are judged by the same rule. The encoder (about 3 MB)
is loaded only when an import has maps to compress, and only in the editor.

## Exporting back out

A model's **Export .glb** button writes:
- its geometry;
- every PBR map, with an ORM map written once for both of its slots;
- its material factors and its material sets.

Skeletons and clips are not written yet, so take rigged changes back to the
`.blend` file.

## Checklist

- [ ] Exported as `.glb`, +Y up, modifiers applied
- [ ] One armature, with four influences per vertex at most
- [ ] Actions named for what they do
- [ ] Data maps set to Non-Color; ORM packed as R occlusion, G roughness, B metal
- [ ] Material sets made under glTF Variants, with Export Variants on
- [ ] After import: team-colour parts ticked, and the generated state machine
      edited into the transitions the game needs
