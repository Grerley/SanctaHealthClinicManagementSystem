/**
 * @sancta/ui — the component library (spec §11). Semantic, accessible React
 * primitives over @sancta/design-tokens. Import '@sancta/ui/src/ui.css' and
 * '@sancta/design-tokens/css' once at the app root.
 */
export { Button, type ButtonProps } from './Button.tsx';
export { StatusTag, StateTag } from './StatusTag.tsx';
export { Banner } from './Banner.tsx';
export { StateBlock } from './StateBlock.tsx';
export { ConnectivityIndicator } from './ConnectivityIndicator.tsx';
export { PatientIdentityStrip, twoIdentifiers, type PatientStripData, type PatientAlert } from './PatientIdentityStrip.tsx';
export { Field, type FieldProps } from './Field.tsx';
export { Icon, type IconName } from './icons.tsx';
export { statePresentation, composeStatusCopy, type StatePresentation, type StatusCopyParts } from './state.ts';
export { connectivityPresentation, type ConnectivityInputs, type ConnectivityPresentation } from './connectivity.ts';
