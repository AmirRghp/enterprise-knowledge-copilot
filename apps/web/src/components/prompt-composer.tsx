"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";
import { Button } from "@base-ui/react/button";
import { Warp, type WarpProps } from "@paper-design/shaders-react";
import { Send } from "lucide-react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";

type BorderGlow = {
  opacityIdle: number;
  primaryBg: string;
  secondaryBg: string;
  tertiaryBg: string;
  primaryLeft: string[];
  secondaryLeft: string[];
  tertiaryLeft: string[];
  durationMain: number;
  durationSec: number;
  durationTer: number;
};

const RIM_GRADIENTS = {
  primary: "var(--composer-rim-primary)",
  secondary: "var(--composer-rim-secondary)",
  tertiary: "var(--composer-rim-tertiary)",
};

const DEFAULT_WARP: Partial<WarpProps> = {
  colors: ["#fda4af", "#0070f3", "#fb923c", "#f472b6", "#00d4ff"],
  distortion: 0.25,
  height: 720,
  proportion: 0.54,
  scale: 0.2,
  shape: "checks",
  shapeScale: 1,
  softness: 1,
  speed: 0.1,
  swirl: 0.8,
  swirlIterations: 10,
  width: 1280,
};

const LOADING_STAGGER_SEC = 0.038;
const LOADING_CHAR_DURATION_SEC = 0.36;

function borderGlowConfig(translucent: boolean, focused: boolean): BorderGlow {
  return {
    opacityIdle: translucent ? (focused ? 0.92 : 0.72) : focused ? 0.78 : 0.5,
    primaryBg: RIM_GRADIENTS.primary,
    secondaryBg: RIM_GRADIENTS.secondary,
    tertiaryBg: RIM_GRADIENTS.tertiary,
    primaryLeft: ["-5%", "75%", "-5%"],
    secondaryLeft: ["65%", "10%", "65%"],
    tertiaryLeft: ["25%", "55%", "25%"],
    durationMain: 6,
    durationSec: 5,
    durationTer: 4,
  };
}

function RimBlobs({ glow, reduceMotion }: { glow: BorderGlow; reduceMotion: boolean }) {
  const blobs = [
    {
      variant: "primary",
      left: glow.primaryLeft,
      background: glow.primaryBg,
      duration: glow.durationMain,
    },
    {
      variant: "secondary",
      left: glow.secondaryLeft,
      background: glow.secondaryBg,
      duration: glow.durationSec,
    },
    {
      variant: "tertiary",
      left: glow.tertiaryLeft,
      background: glow.tertiaryBg,
      duration: glow.durationTer,
    },
  ];
  return (
    <div aria-hidden="true" className="prompt-composer-rim-blobs">
      <motion.div
        animate={{ opacity: reduceMotion ? glow.opacityIdle * 0.82 : glow.opacityIdle }}
        className="prompt-composer-rim-row"
        transition={{ duration: 0.25, ease: "easeOut" }}
      >
        {blobs.map((blob) => (
          <motion.div
            animate={{ left: blob.left }}
            className={`prompt-composer-rim-blob prompt-composer-rim-${blob.variant}`}
            key={blob.variant}
            style={{ background: blob.background }}
            transition={{
              duration: reduceMotion ? 0.01 : blob.duration,
              repeat: reduceMotion ? 0 : Number.POSITIVE_INFINITY,
              ease: "easeInOut",
            }}
          />
        ))}
      </motion.div>
    </div>
  );
}

function WarpAvatar({ loading, typing }: { loading: boolean; typing: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rootRef, { amount: 0.2, margin: "0px 0px -10% 0px" });
  const reduceMotion = useReducedMotion() ?? false;
  const live = inView && !reduceMotion;
  const pulseDurationSec = loading ? 1.65 : typing ? 2.65 : 5.2;
  const warpSpeed = loading ? 3.45 : typing ? 2.65 : 1.15;

  return (
    <div className="prompt-composer-avatar" ref={rootRef} aria-hidden="true">
      <motion.div
        animate={
          live ? { scale: [1, 1.055, 0.99, 1], rotate: [0, 2, -1.5, 0] } : { scale: 1, rotate: 0 }
        }
        className="prompt-composer-avatar-warp"
        transition={{ duration: pulseDurationSec, ease: "easeInOut", repeat: Infinity }}
      >
        <Warp {...DEFAULT_WARP} speed={live ? warpSpeed : 0} />
      </motion.div>
    </div>
  );
}

function AmbientBackdrop({ emphasis, reduceMotion }: { emphasis: boolean; reduceMotion: boolean }) {
  const drift = reduceMotion
    ? { duration: 0 }
    : { duration: 18, repeat: Infinity, ease: "easeInOut" as const };
  return (
    <div className="prompt-composer-ambient" aria-hidden="true">
      <motion.div
        animate={
          reduceMotion
            ? { opacity: emphasis ? 0.11 : 0.07 }
            : {
                opacity: emphasis ? [0.08, 0.14, 0.08] : [0.05, 0.1, 0.05],
                x: ["-4%", "5%", "-4%"],
                y: ["-2%", "3%", "-2%"],
              }
        }
        className="prompt-composer-orb prompt-composer-orb-pink"
        transition={drift}
      />
      <motion.div
        animate={
          reduceMotion
            ? { opacity: emphasis ? 0.1 : 0.06 }
            : {
                opacity: emphasis ? [0.07, 0.12, 0.07] : [0.04, 0.09, 0.04],
                x: ["5%", "-4%", "5%"],
                y: ["2%", "-2%", "2%"],
              }
        }
        className="prompt-composer-orb prompt-composer-orb-blue"
        transition={{ ...drift, duration: reduceMotion ? 0 : 22 }}
      />
      <div className="prompt-composer-vignette" />
    </div>
  );
}

function AnimatedText({
  text,
  animateKey,
  reduceMotion,
  loading = false,
}: {
  text: string;
  animateKey: number;
  reduceMotion: boolean;
  loading?: boolean;
}) {
  const segments = useMemo(() => text.match(/\S+\s*/g) ?? [text], [text]);

  return (
    <motion.span
      animate="visible"
      className="prompt-composer-placeholder"
      initial="hidden"
      key={animateKey}
      variants={{
        hidden: {},
        visible: {
          transition: { staggerChildren: reduceMotion ? 0 : loading ? LOADING_STAGGER_SEC : 0.018 },
        },
      }}
    >
      {segments.map((segment, index) => (
        <motion.span
          className="prompt-composer-placeholder-char"
          key={`${segment}-${index}`}
          transition={{
            duration: reduceMotion ? 0 : loading ? LOADING_CHAR_DURATION_SEC : 0.16,
            ease: "easeOut",
          }}
          variants={{
            hidden: { opacity: reduceMotion ? 1 : 0 },
            visible: { opacity: 1 },
          }}
        >
          {segment}
        </motion.span>
      ))}
    </motion.span>
  );
}

function Spinner({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <motion.svg
      animate={reduceMotion ? undefined : { rotate: 360 }}
      aria-hidden="true"
      className="prompt-composer-spinner"
      fill="none"
      focusable="false"
      transition={reduceMotion ? undefined : { duration: 1, ease: "linear", repeat: Infinity }}
      viewBox="0 0 24 24"
    >
      <circle
        className="prompt-composer-spinner-track"
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2.25"
      />
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeDasharray="14 42"
        strokeLinecap="round"
        strokeWidth="2.25"
      />
    </motion.svg>
  );
}

export interface PromptComposerProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onResize" | "children"
> {
  isLoading?: boolean;
  loadingText?: string;
  onSend?: () => void;
  maxAutoGrowPx?: number;
}

export const PromptComposer = forwardRef<HTMLTextAreaElement, PromptComposerProps>(
  function PromptComposer(
    {
      className = "",
      value,
      onChange,
      onKeyDown,
      placeholder = "پیام خود را بنویسید…",
      isLoading = false,
      loadingText = "در حال پاسخ…",
      disabled,
      readOnly,
      onSend,
      maxAutoGrowPx = 280,
      ...props
    },
    forwardedRef,
  ) {
    const fieldId = useId();
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const typingIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [internalValue, setInternalValue] = useState("");
    const [focused, setFocused] = useState(false);
    const [placeholderKey, setPlaceholderKey] = useState(0);
    const [loadingKey, setLoadingKey] = useState(0);
    const [typing, setTyping] = useState(false);
    const previousLoading = useRef(isLoading);
    const reduceMotion = useReducedMotion() ?? false;
    const currentValue = value === undefined ? internalValue : value;
    const hasValue = String(currentValue).trim().length > 0;
    const canSend = hasValue && !isLoading && !disabled && !readOnly;
    const translucent = isLoading;

    useEffect(() => {
      if (isLoading && !previousLoading.current) setLoadingKey((key) => key + 1);
      previousLoading.current = isLoading;
    }, [isLoading]);

    useEffect(
      () => () => {
        if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
      },
      [],
    );

    const setRefs = useCallback(
      (node: HTMLTextAreaElement | null) => {
        textareaRef.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    const adjustHeight = useCallback(() => {
      const field = textareaRef.current;
      if (!field) return;
      field.style.height = "auto";
      field.style.height = `${Math.min(field.scrollHeight, maxAutoGrowPx)}px`;
    }, [maxAutoGrowPx]);

    useEffect(() => {
      adjustHeight();
    }, [adjustHeight, currentValue]);

    const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
      const previousLength = String(currentValue).length;
      if (!event.target.value.length && previousLength) setPlaceholderKey((key) => key + 1);
      if (onChange) onChange(event);
      else setInternalValue(event.target.value);
      if (reduceMotion) return;
      if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
      setTyping(true);
      typingIdleTimer.current = setTimeout(() => {
        setTyping(false);
        typingIdleTimer.current = null;
      }, 420);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyDown?.(event);
      if (
        !event.defaultPrevented &&
        !event.nativeEvent.isComposing &&
        event.key === "Enter" &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        if (canSend) onSend?.();
      }
    };

    const glow = useMemo(() => borderGlowConfig(translucent, focused), [translucent, focused]);
    const crossfade = reduceMotion ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.88 };

    return (
      <div className={`prompt-composer ${className}`}>
        <div className="prompt-composer-frame">
          <AmbientBackdrop emphasis={focused || translucent} reduceMotion={reduceMotion} />
          <RimBlobs glow={glow} reduceMotion={reduceMotion} />
          <div
            className={`prompt-composer-card${focused ? " is-focused" : ""}${translucent ? " is-translucent" : ""}`}
            aria-busy={isLoading || undefined}
          >
            <div className="prompt-composer-entry">
              <WarpAvatar loading={isLoading} typing={typing} />
              <div className="prompt-composer-field-wrap">
                <textarea
                  {...props}
                  aria-label={props["aria-label"] ?? "پرسش شما"}
                  className="prompt-composer-field"
                  disabled={disabled}
                  id={props.id ?? fieldId}
                  onBlur={() => setFocused(false)}
                  onChange={handleChange}
                  onFocus={() => setFocused(true)}
                  onKeyDown={handleKeyDown}
                  placeholder=""
                  readOnly={readOnly || isLoading}
                  ref={setRefs}
                  rows={props.rows ?? 2}
                  value={currentValue}
                  dir="rtl"
                />
                {isLoading && (
                  <AnimatedText
                    text={loadingText}
                    animateKey={loadingKey}
                    reduceMotion={reduceMotion}
                    loading
                  />
                )}
                {!(hasValue || isLoading) && (
                  <AnimatedText
                    text={placeholder}
                    animateKey={placeholderKey}
                    reduceMotion={reduceMotion}
                  />
                )}
              </div>
            </div>
            <div className="prompt-composer-footer">
              <span className="prompt-composer-footer-rule" aria-hidden="true" />
              <div className="prompt-composer-actions">
                <div className="prompt-composer-send-slot">
                  <AnimatePresence initial={false} mode="popLayout">
                    {isLoading ? (
                      <motion.div
                        animate={{ opacity: 1, scale: 1 }}
                        aria-hidden="true"
                        className="prompt-composer-send-loading"
                        exit={crossfade}
                        initial={crossfade}
                        key="composer-loading"
                        layoutId="prompt-composer-trailing"
                        transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
                      >
                        <Spinner reduceMotion={reduceMotion} />
                      </motion.div>
                    ) : (
                      <motion.div
                        animate={{ opacity: 1, scale: 1 }}
                        className="prompt-composer-send-wrap"
                        exit={crossfade}
                        initial={crossfade}
                        key="composer-send"
                        layoutId="prompt-composer-trailing"
                        transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
                      >
                        <Button
                          aria-label="ارسال پرسش"
                          className="prompt-composer-send"
                          disabled={!canSend}
                          onClick={() => onSend?.()}
                          type="button"
                        >
                          <Send aria-hidden="true" size={17} />
                        </Button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  },
);

PromptComposer.displayName = "PromptComposer";
