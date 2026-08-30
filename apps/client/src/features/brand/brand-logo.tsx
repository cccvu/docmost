import { Group, Text, useComputedColorScheme } from "@mantine/core";
import classes from "./brand-logo.module.css";
import vuCccBlack from "./assets/vu-ccc-black.png";
import vuCccWhite from "./assets/vu-ccc-white.png";
import vIcon from "./assets/v-icon.png";

/**
 * CCC brand mark (issue #30). Renders the official Vanderbilt · College of
 * Connected Computing lockup (theme-swapped black↔white — never CSS-inverted, so
 * the gold Dimensional V is preserved) with an optional app-name wordmark, or a
 * compact / icon-only variant for dense or narrow chrome.
 *
 * Accessibility: the artwork is decorative by default (`alt=""`); callers give
 * the mark an accessible name via a wrapping labelled control (e.g. a Link's
 * `aria-label`) or the adjacent visible `appName`. Callers that render the mark
 * outside a labelled control (e.g. a static auth header) should pass a
 * meaningful `alt`.
 */

export const INSTITUTION_NAME =
  "Vanderbilt University · College of Connected Computing";

type BrandVariant = "lockup" | "compact" | "icon";

interface BrandProps {
  /** `lockup` = VU·CCC art; `compact` = V icon + name; `icon` = V icon only. */
  variant?: BrandVariant;
  /** Wordmark shown beside the mark (lockup + compact). Omit for mark-only. */
  appName?: string;
  /** Pixel height of the lockup artwork (default 24). */
  lockupHeight?: number;
  /** Pixel height of the V icon (default 24). */
  iconHeight?: number;
  /** Alt text for the artwork. Default "" (decorative). */
  alt?: string;
  className?: string;
}

function cx(...values: Array<string | false | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function Brand({
  variant = "lockup",
  appName,
  lockupHeight = 24,
  iconHeight = 24,
  alt = "",
  className,
}: BrandProps) {
  const scheme = useComputedColorScheme("light");
  const lockupSrc = scheme === "dark" ? vuCccWhite : vuCccBlack;

  if (variant === "icon") {
    return (
      <img
        src={vIcon}
        alt={alt}
        className={cx(classes.vIcon, className)}
        style={{ height: iconHeight }}
      />
    );
  }

  if (variant === "compact") {
    return (
      <Group gap={8} wrap="nowrap" className={cx(classes.root, className)}>
        <img
          src={vIcon}
          alt={alt}
          className={classes.vIcon}
          style={{ height: iconHeight }}
        />
        {appName ? (
          <Text className={classes.name} style={{ fontSize: iconHeight * 0.72 }}>
            {appName}
          </Text>
        ) : null}
      </Group>
    );
  }

  // lockup
  return (
    <Group gap="sm" wrap="nowrap" className={cx(classes.root, className)}>
      <img
        src={lockupSrc}
        alt={alt}
        className={classes.lockup}
        style={{ height: lockupHeight }}
      />
      {appName ? (
        <>
          <span
            aria-hidden="true"
            className={classes.divider}
            style={{ height: Math.round(lockupHeight * 0.9) }}
          />
          <Text
            className={classes.name}
            style={{ fontSize: Math.round(lockupHeight * 0.72) }}
          >
            {appName}
          </Text>
        </>
      ) : null}
    </Group>
  );
}
