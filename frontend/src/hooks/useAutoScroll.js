import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
} from "react";
import Appearance from "@/models/appearance";

/**
 * Owns all auto-scroll behavior for the chat history container.
 *
 * Follow model: while `followRef` is true the container is pinned to the
 * bottom every animation frame. The user disengages by scrolling up
 * (wheel/touch) and re-engages by scrolling back down to the bottom,
 * sending a new prompt, or clicking the scroll-to-bottom button.
 *
 * @param {Array} history - The chat history (drives follow re-engage on send)
 * @param {React.Ref} imperativeRef - Forwarded ref exposing scrollToTop/scrollToBottom
 */
export default function useAutoScroll(history, imperativeRef) {
  const disabled = Appearance.get("disableAutoScroll");
  const chatHistoryRef = useRef(null);
  const followRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const touchStartYRef = useRef(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const scrollToBottom = useCallback((smooth = false) => {
    if (!chatHistoryRef.current) return;
    chatHistoryRef.current.scrollTo({
      top: chatHistoryRef.current.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  // Pin to the bottom for a window of frames. A single scroll on load is not
  // enough — markdown, citations, and images below the fold keep resizing
  // the content after our scroll, leaving the view stranded mid-message.
  // Stops early if the user scrolls up (followRef flips false).
  const pinFramesRef = useRef(0);
  const pinToBottom = useCallback((frames = 30) => {
    const alreadyPinning = pinFramesRef.current > 0;
    pinFramesRef.current = frames;
    if (alreadyPinning) return;
    const tick = () => {
      const el = chatHistoryRef.current;
      if (!el || !followRef.current || pinFramesRef.current-- <= 0) {
        pinFramesRef.current = 0;
        return;
      }
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, []);

  // On the first render with content (page load / chat switch), always land
  // at the latest message — regardless of the autoscroll setting. After
  // that: with autoscroll disabled, never move the user's scroll again;
  // with it enabled, re-engage follow on send and pin before paint so the
  // new message never appears above the fold.
  const loadedRef = useRef(false);
  const prevHistoryRef = useRef({ length: 0, userCount: 0 });
  useLayoutEffect(() => {
    if (history.length === 0) {
      loadedRef.current = false;
      prevHistoryRef.current = { length: 0, userCount: 0 };
      return;
    }
    if (!loadedRef.current) {
      loadedRef.current = true;
      prevHistoryRef.current = {
        length: history.length,
        userCount: history.filter((m) => m?.role === "user").length,
      };
      scrollToBottom(false);
      pinToBottom();
      return;
    }

    const prev = prevHistoryRef.current;
    const userCount = history.filter((m) => m?.role === "user").length;
    const grew = history.length > prev.length;
    const lastMsg = history[history.length - 1];
    // A new user prompt is the only thing that should re-engage follow.
    // Assistant streaming/status updates must not yank the view back after
    // the user has scrolled up to read.
    const startedNewTurn =
      grew &&
      (lastMsg?.role === "user" ||
        (lastMsg?.pending && history[history.length - 2]?.role === "user"));
    prevHistoryRef.current = { length: history.length, userCount };

    if (disabled) return;
    if (userCount > prev.userCount || startedNewTurn) followRef.current = true;
    if (followRef.current) scrollToBottom(false);
  }, [history, scrollToBottom, pinToBottom, disabled]);

  // While following a stream, pin to the bottom every frame. Content below
  // the fold resizes asynchronously during streaming (markdown re-renders,
  // components swapping, the prompt input growing/clearing) — an effect-based
  // scroll races those shifts and loses; a rAF loop always runs after layout.
  // Only runs while the last message is streaming so idle chats (even very
  // long ones) pay nothing — reading scrollHeight each frame on a huge DOM
  // can force reflows if layout is dirty.
  const lastMsg = history[history.length - 1];
  const isStreaming = !!(lastMsg?.animate || lastMsg?.pending);
  useEffect(() => {
    if (!isStreaming || disabled) return;
    let frame;
    const tick = () => {
      const el = chatHistoryRef.current;
      if (el && followRef.current) el.scrollTop = el.scrollHeight;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isStreaming]);

  const handleScroll = useCallback(() => {
    if (!chatHistoryRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatHistoryRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    const scrolledUp = scrollTop < lastScrollTopRef.current;
    const scrolledDown = scrollTop > lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;
    setIsAtBottom(atBottom);
    // Any upward movement (wheel, touch, scrollbar drag, keyboard) opts out
    // of following. Only a downward scroll into the bottom zone re-engages.
    if (scrolledUp) followRef.current = false;
    else if (atBottom && scrolledDown) followRef.current = true;
  }, []);

  const handleWheel = useCallback((e) => {
    if (e.deltaY < 0) followRef.current = false;
  }, []);

  const handleTouchStart = useCallback((e) => {
    touchStartYRef.current = e.touches[0].clientY;
  }, []);

  const handleTouchMove = useCallback((e) => {
    const startY = touchStartYRef.current;
    if (startY != null && e.touches[0].clientY > startY) {
      followRef.current = false;
    }
  }, []);

  useImperativeHandle(
    imperativeRef,
    () => ({
      scrollToTop() {
        followRef.current = false;
        if (chatHistoryRef.current) {
          chatHistoryRef.current.scrollTo({ top: 0, behavior: "smooth" });
        }
      },
      scrollToBottom() {
        scrollToBottom(true);
      },
    }),
    [scrollToBottom]
  );

  return {
    chatHistoryRef,
    isAtBottom,
    scrollToBottom,
    scrollHandlers: {
      onScroll: handleScroll,
      onWheel: handleWheel,
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
    },
  };
}
