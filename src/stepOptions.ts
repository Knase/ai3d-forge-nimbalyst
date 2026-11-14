/**
 * The options of each step, as real controls. An option left on "agent decides" is not sent; a chosen one goes
 * into the prompt as "use exactly this" and is saved on the attempt, so two attempts can be compared.
 */
export interface StepOption {
  key: string;
  label: string;
  help: string;
  kind: 'choice' | 'number' | 'text';
  choices?: { value: string; label: string }[];
  unit?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
}

const c = (...v: (string | [string, string])[]) => v.map((x) => (typeof x === 'string' ? { value: x, label: x } : { value: x[0], label: x[1] }));

export const STEP_OPTIONS: Record<string, StepOption[]> = {
  concept: [
    { key: 'model_type', label: 'Model type', help: 'Static figure, print-in-place flexi, or a functional part.', kind: 'choice', choices: c('static', 'flexi', 'functional') },
    { key: 'scale_mm', label: 'Size', help: 'Longest side of the printed model.', kind: 'number', unit: 'mm', min: 10, max: 400, step: 5, placeholder: '120' },
    { key: 'style', label: 'Style', help: 'How it should look.', kind: 'text', placeholder: 'chibi, low-poly, realistic…' },
    { key: 'print_target', label: 'Printer type', help: 'Drives wall thickness and the smallest detail.', kind: 'choice', choices: c('FDM', 'resin') },
  ],
  image: [
    { key: 'mode', label: 'How', help: 'A new picture from scratch, or an edit of the previous one (keeps the pose, changes a detail).', kind: 'choice', choices: c(['new', 'New picture'], ['edit', 'Edit the previous picture']) },
    { key: 'view', label: 'Camera', help: 'Three-quarter front suits single-image 3D best.', kind: 'choice', choices: c(['three-quarter', 'Three-quarter front'], ['front', 'Front'], ['side', 'Side']) },
    { key: 'style', label: 'Style', help: 'Overrides the style of the concept for this picture.', kind: 'text', placeholder: 'chibi, clay toy, low-poly…' },
    { key: 'aspect', label: 'Aspect ratio', help: '', kind: 'choice', choices: c('1:1', '4:3', '3:4') },
    { key: 'backend', label: 'Image model', help: 'Which Gemini model the prompt is written for.', kind: 'choice', choices: c(['nano-banana-pro', 'Nano Banana Pro (quality)'], ['nano-banana-2', 'Nano Banana 2 (speed)']) },
  ],
  mesh: [
    { key: 'service', label: '3D service', help: 'The spec is written for this service.', kind: 'choice', choices: c(['tripo3d', 'Tripo3D'], ['meshy', 'Meshy'], ['rodin', 'Rodin / Hyper3D'], ['hitem3d', 'Hitem3D']) },
    { key: 'mode', label: 'Input', help: 'Multi-view needs accepted views (Image step → Prepare views).', kind: 'choice', choices: c(['single', 'One image'], ['multiview', 'Multi-view (front, left, back, right)']) },
    { key: 'texture', label: 'Texture', help: 'Off is enough for printing and costs fewer credits.', kind: 'choice', choices: c('off', 'on') },
    { key: 'topology', label: 'Topology', help: 'Quad is cleaner to edit in Blender.', kind: 'choice', choices: c('quad', 'triangle') },
    { key: 'face_limit', label: 'Face limit', help: '50 000–200 000 is plenty for a print.', kind: 'number', min: 5000, max: 2000000, step: 5000, placeholder: '100000' },
    { key: 'segmentation', label: 'Split into parts', help: 'On for flexi models and models you will print in parts.', kind: 'choice', choices: c('on', 'off') },
    { key: 'symmetry', label: 'Symmetry', help: 'On for symmetric animals and characters.', kind: 'choice', choices: c('on', 'off', 'auto') },
  ],
  blender: [
    { key: 'side_on_bed', label: 'Side on the bed', help: 'Which side lies on the print bed. Analyze lists the best ones.', kind: 'choice', choices: c('bottom', 'back', 'front', 'left', 'right', 'top') },
    { key: 'cut_mm', label: 'Flat cut', help: 'How much is cut off for a flat base (0.5–1.5 is usual).', kind: 'number', unit: 'mm', min: 0, max: 20, step: 0.1, placeholder: '1' },
    { key: 'overhang_deg', label: 'Overhang angle', help: 'Faces steeper than this count as needing support.', kind: 'number', unit: '°', min: 20, max: 75, step: 1, placeholder: '45' },
    { key: 'scale_mm', label: 'Size', help: 'Longest side after scaling.', kind: 'number', unit: 'mm', min: 10, max: 400, step: 5, placeholder: '120' },
    { key: 'flexi', label: 'Flexi joints', help: 'Build print-in-place joints.', kind: 'choice', choices: c('yes', 'no') },
    { key: 'segments', label: 'Segments', help: 'Number of body segments for flexi.', kind: 'number', min: 2, max: 30, step: 1, placeholder: '9' },
    { key: 'clearance_mm', label: 'Joint clearance', help: 'Gap in the joints; take it from your coupon print.', kind: 'number', unit: 'mm', min: 0.1, max: 1, step: 0.05, placeholder: '0.35' },
  ],
  validate: [
    { key: 'slicer', label: 'Slicer', help: 'The slicing notes use its setting names.', kind: 'choice', choices: c('Bambu Studio', 'OrcaSlicer', 'PrusaSlicer', 'Cura') },
    { key: 'nozzle_mm', label: 'Nozzle', help: '', kind: 'choice', choices: c('0.2', '0.4', '0.6', '0.8') },
    { key: 'layer_mm', label: 'Layer height', help: '', kind: 'number', unit: 'mm', min: 0.04, max: 0.6, step: 0.02, placeholder: '0.16' },
    { key: 'material', label: 'Material', help: '', kind: 'choice', choices: c('PLA', 'PETG', 'TPU', 'ABS / ASA') },
  ],
  publish: [
    { key: 'target', label: 'Marketplace', help: 'The listing is written for it.', kind: 'choice', choices: c(['makerworld', 'MakerWorld'], ['printables', 'Printables'], ['thingiverse', 'Thingiverse'], ['cults3d', 'Cults3D']) },
    { key: 'tone', label: 'Tone of the text', help: '', kind: 'text', placeholder: 'playful, short, for parents…' },
  ],
};

/** Ready phrases for "what should be different", per step. */
export const QUICK_NOTES: Record<string, string[]> = {
  concept: ['Make it flexi instead of static', 'Bigger, so details survive', 'Simplify: fewer small parts'],
  image: ['Legs apart, nothing touching', 'Thicker limbs, no thin parts', 'Plain background, no shadow', 'Same pose, fix only the face'],
  mesh: ['Texture off, geometry only', 'The last mesh fused parts: split them', 'Fewer faces, cleaner surface'],
  blender: ['Try another side on the bed', 'Thicker base', 'Less overhang, even if a detail is lost', 'Bigger joint clearance'],
  validate: ['Check thin walls again', 'Profile for a 0.4 nozzle, 0.16 layers'],
  publish: ['Shorter description', 'Add the print settings table'],
};

/** Keys the panel adds itself; never shown as options. */
export const INTERNAL_KEYS = new Set(['run_model', 'run_effort']);
