import React from "react";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "tab" | "icon";
};

/**
 * Unified button styles for the whole app — the brutalist boxed language:
 * square corners, black uppercase type, solid accent fill. Variants:
 * - primary: filled accent box (selected nav tab, confirm actions)
 * - tab:     bare label, no box (unselected nav tabs)
 * - icon:    filled accent square for icon-only actions (settings gear)
 *
 * The transparent borders are deliberate: they keep every tab exactly the
 * same width whether or not it is selected, so switching tabs does not make
 * the row reflow.
 */
export const Buttons: React.FC<ButtonProps> = ({
  variant = "tab",
  type = "button",
  className = "",
  ...props
}) => {
  const base =
    "cursor-pointer border transition-colors focus:outline-none focus-visible:outline-2 focus-visible:outline-brand-accent focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed";
  const variants: Record<NonNullable<ButtonProps["variant"]>, string> = {
    primary:
      "bg-brand-accent text-black border-transparent hover:bg-brand-accent-hover font-black uppercase tracking-wider text-xs",
    tab:
      "bg-transparent text-brand-muted border-transparent hover:text-brand-accent font-black uppercase tracking-wider text-xs",
    icon:
      "bg-brand-accent text-black border-transparent hover:bg-brand-accent-hover",
  };
  return (
    <button type={type} className={`${base} ${variants[variant]} ${className}`} {...props} />
  );
};

export default Buttons;
