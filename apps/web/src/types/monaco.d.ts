declare module "@monaco-editor/react" {
  import type { ComponentType, ReactNode } from "react";

  export type MonacoOnChange = (value: string | undefined, ev?: unknown) => void;

  export type MonacoEditorProps = {
    height?: string | number;
    width?: string | number;
    language?: string;
    theme?: string;
    value?: string;
    options?: Record<string, unknown>;
    onChange?: MonacoOnChange;
    loading?: ReactNode;
    className?: string;
  };

  const Editor: ComponentType<MonacoEditorProps>;
  export default Editor;
}
