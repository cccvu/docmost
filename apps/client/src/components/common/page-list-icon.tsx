import { ThemeIcon } from "@mantine/core";
import { IconFileDescription, IconTable } from "@tabler/icons-react";

type Props = {
  icon?: string | null;
  isBase?: boolean;
};

export function PageListIcon({ isBase }: Props) {
  // CCC (issue: UI polish): always the default document/table icon — a stored emoji is no
  // longer rendered as a page icon. `icon` stays in Props so call sites need no change.
  return (
    <ThemeIcon variant="transparent" color="gray" size={18}>
      {isBase ? <IconTable size={18} /> : <IconFileDescription size={18} />}
    </ThemeIcon>
  );
}
