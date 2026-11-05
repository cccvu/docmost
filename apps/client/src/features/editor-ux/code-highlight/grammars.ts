// CCC (issue #407): the highlight.js grammars, reached ONLY through the dynamic import in lowlight.ts so
// they land in one lazy chunk. vite.config.ts `mustStayLazy` fails the build if any of them reaches the
// initial set. The set is exactly what extensions.ts registered eagerly before #407.
import { common, type createLowlight } from "lowlight";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import abap from "highlightjs-sap-abap";
import elixir from "highlight.js/lib/languages/elixir";
import erlang from "highlight.js/lib/languages/erlang";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import clojure from "highlight.js/lib/languages/clojure";
import fortran from "highlight.js/lib/languages/fortran";
import haskell from "highlight.js/lib/languages/haskell";
import scala from "highlight.js/lib/languages/scala";

export function registerCodeGrammars(
  lowlight: ReturnType<typeof createLowlight>,
): void {
  lowlight.register(common);
  lowlight.register("mermaid", plaintext);
  lowlight.register("powershell", powershell);
  lowlight.register("abap", abap);
  lowlight.register("erlang", erlang);
  lowlight.register("elixir", elixir);
  lowlight.register("dockerfile", dockerfile);
  lowlight.register("clojure", clojure);
  lowlight.register("fortran", fortran);
  lowlight.register("haskell", haskell);
  lowlight.register("scala", scala);
}
