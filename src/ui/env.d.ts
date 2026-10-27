/** Stylesheets are bundled by Vite (ADR 0011); importing one has no value. */
declare module '*.css';

interface ImportMetaEnv {
  /** `fixture` selects the committed fixtures instead of the local application. */
  readonly VITE_EOAI_SOURCE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
