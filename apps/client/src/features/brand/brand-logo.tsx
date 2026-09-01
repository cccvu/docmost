import { Group, Text } from "@mantine/core";
import clsx from "clsx";
import classes from "./brand-logo.module.css";
import vIcon from "./assets/v-icon.png";
// The official "VANDERBILT UNIVERSITY" serif wordmark, as vector artwork (the
// exact path used by computing.vanderbilt.edu). Inlined (not <img>) so its
// `currentColor` fill themes with the surrounding ink.
import wordmarkSvg from "./assets/vu-wordmark.svg?raw";

/**
 * CCC brand mark (issue #30). Mirrors the College of Connected Computing site
 * lockup (computing.vanderbilt.edu): the gold Dimensional V, the official serif
 * "Vanderbilt University" wordmark as vector art, and "College of Connected
 * Computing" as sans (Inter) text — with an optional app-name wordmark, or a
 * compact / icon-only variant for dense or narrow chrome.
 *
 * Accessibility: the V is decorative (`alt=""`); the wordmark art carries the
 * accessible name "Vanderbilt University" (or a caller-supplied `alt`), and the
 * college line is live text. In the app header the whole mark sits inside a
 * labelled Link, whose `aria-label` names it.
 */

export const INSTITUTION_NAME =
  "Vanderbilt University · College of Connected Computing";

const COLLEGE_NAME = "College of Connected Computing";

type BrandVariant = "lockup" | "compact" | "icon";

interface BrandProps {
  /** `lockup` = V + wordmark + college; `compact` = V icon + name; `icon` = V only. */
  variant?: BrandVariant;
  /** Wordmark shown beside the mark (lockup + compact). Omit for mark-only. */
  appName?: string;
  /** Pixel height of the lockup mark — the V and text block (default 24). */
  lockupHeight?: number;
  /** Pixel height of the V icon (default 24). */
  iconHeight?: number;
  /** Accessible name for the wordmark artwork. Default "Vanderbilt University". */
  alt?: string;
  className?: string;
}

export function Brand({
  variant = "lockup",
  appName,
  lockupHeight = 24,
  iconHeight = 24,
  alt = "",
  className,
}: BrandProps) {
  if (variant === "icon") {
    return (
      <img
        src={vIcon}
        alt={alt}
        className={clsx(classes.vIcon, className)}
        style={{ height: iconHeight }}
      />
    );
  }

  if (variant === "compact") {
    return (
      <Group gap={8} wrap="nowrap" className={clsx(classes.root, className)}>
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

  // lockup — gold V + official serif wordmark (SVG) + college name (Inter sans).
  const h = lockupHeight;
  return (
    <Group gap={10} wrap="nowrap" className={clsx(classes.root, className)}>
      <img
        src={vIcon}
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
          aria-label={alt || "Vanderbilt University"}
          // Trusted, build-time-bundled brand asset (no user input).
          dangerouslySetInnerHTML={{ __html: wordmarkSvg }}
        />
        <span className={classes.college} style={{ fontSize: Math.round(h * 0.4) }}>
          {COLLEGE_NAME}
        </span>
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
