import * as autocomplete from "@codemirror/autocomplete";
import * as collab from "@codemirror/collab";
import * as commands from "@codemirror/commands";
import * as language from "@codemirror/language";
import * as lint from "@codemirror/lint";
import * as search from "@codemirror/search";
import * as state from "@codemirror/state";
import * as view from "@codemirror/view";
import * as common from "@lezer/common";
import * as highlight from "@lezer/highlight";
import * as lr from "@lezer/lr";

export const trustedHostModules = Object.freeze({
  "@codemirror/autocomplete": autocomplete,
  "@codemirror/collab": collab,
  "@codemirror/commands": commands,
  "@codemirror/language": language,
  "@codemirror/lint": lint,
  "@codemirror/search": search,
  "@codemirror/state": state,
  "@codemirror/view": view,
  "@lezer/common": common,
  "@lezer/highlight": highlight,
  "@lezer/lr": lr,
});

export type TrustedHostModuleTable = typeof trustedHostModules;
