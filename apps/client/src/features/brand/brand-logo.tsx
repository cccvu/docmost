import { Group, Text } from "@mantine/core";
import clsx from "clsx";
import classes from "./brand-logo.module.css";
import { useBrandConfig } from "./brand-hooks";

/**
 * Institution brand mark, rendered from the runtime brand bundle (issue #30 follow-up).
 *
 * The public AGPL fork ships NO brand artwork — `assets/` was removed. When `/brand/manifest.json` is
 * served (by the proprietary platform, same-origin) the mark renders that institution's lockup: the icon,
 * the wordmark as inline vector art (fetched as text so its `currentColor` fill themes with the surrounding
 * ink), and the college line. Without a bundle the lockup falls back to the app name as plain text (the
 * compact variant shows the name only when the caller passes one, and the icon variant renders nothing) —
 * never to a trademark.
 *
 * Accessibility: the icon is decorative; the wordmark art carries the accessible name (the institution
 * name, or a caller-supplied `alt`); the college line is live text.
 */

type BrandVariant = "lockup" | "compact" | "icon";

interface BrandProps {
  /** `lockup` = mark + wordmark + college; `compact` = icon + name; `icon` = mark only. */
  variant?: BrandVariant;
  /** Text shown beside the mark (lockup + compact), or as the fallback when no bundle is loaded. */
  appName?: string;
  /** Pixel height of the lockup mark — the icon and text block (default 24). */
  lockupHeight?: number;
  /** Pixel height of the icon (default 24). */
  iconHeight?: number;
  /** Accessible name for the wordmark artwork. Defaults to the bundle's institution name. */
  alt?: string;
  className?: string;
}

export function Brand({
  variant = "lockup",
  appName,
  lockupHeight = 24,
  iconHeight = 24,
  alt,
  className,
}: BrandProps) {
  const brand = useBrandConfig();
  const icon = brand.assets.icon;
  const wordmark = brand.wordmarkSvg;
  const college = brand.collegeName;
  const fallbackName = appName ?? brand.name;

  if (variant === "icon") {
    if (!icon) return null;
    return (
      <img
        src={icon}
        alt={alt ?? ""}
        className={clsx(classes.vIcon, className)}
        style={{ height: iconHeight }}
      />
    );
  }

  if (variant === "compact") {
    return (
      <Group gap={8} wrap="nowrap" className={clsx(classes.root, className)}>
        {icon ? (
          <img
            src={icon}
            alt={alt ?? ""}
            className={classes.vIcon}
            style={{ height: iconHeight }}
          />
        ) : null}
        {appName ? (
          <Text className={classes.name} style={{ fontSize: iconHeight * 0.72 }}>
            {appName}
          </Text>
        ) : null}
      </Group>
    );
  }

  // No runtime bundle (or the artwork failed to load): name as text, no trademark artwork.
  if (!icon || !wordmark) {
    return fallbackName ? (
      <Text
        component="span"
        className={clsx(classes.name, className)}
        style={{ fontSize: Math.round(lockupHeight * 0.6) }}
      >
        {fallbackName}
      </Text>
    ) : null;
  }

  const h = lockupHeight;
  return (
    <Group gap={10} wrap="nowrap" className={clsx(classes.root, className)}>
      <img
        src={icon}
        alt=""
        aria-hidden="true"
        className={classes.vIcon}
        style={{ height: h }}
      />
      <span className={classes.textCol} style={{ height: h }}>
        <span
          className={classes.wordmark}
          style={{ height: Math.round(h * 0.26) }}
          role="img"
          aria-label={alt ?? brand.institutionName ?? appName ?? brand.name}
          // Trusted same-origin artwork fetched from the /brand bundle (see brand-config.ts).
          dangerouslySetInnerHTML={{ __html: wordmark }}
        />
        {college ? (
          <span className={classes.college} style={{ fontSize: Math.round(h * 0.4) }}>
            {college}
          </span>
        ) : null}
      </span>
      {appName ? (
        <>
          <span
            aria-hidden="true"
            className={classes.divider}
            style={{ height: Math.round(h * 0.9) }}
          />
          <Text
            className={classes.name}
            style={{ fontSize: Math.round(h * 0.5) }}
          >
            {appName}
          </Text>
        </>
      ) : null}
    </Group>
  );
}
