// Pure pin math. Kept out of the shell module so a unit test can reject a
// NaN offset without booting mutter. Writing NaN to Clutter's
// translation-x is what took the desktop down on File.

export function pinTranslationX({
    buttonX,
    menuX,
    menuWidth,
    translationX = 0,
    monitorLeft = Number.NEGATIVE_INFINITY,
    monitorRight = Number.POSITIVE_INFINITY,
}) {
    const inputs = [buttonX, menuX, menuWidth, translationX];
    if (inputs.some(v => typeof v !== 'number' || !Number.isFinite(v)))
        return null;
    if (menuWidth <= 0)
        return null;

    let desiredLeft = buttonX;
    if (Number.isFinite(monitorRight) && desiredLeft + menuWidth > monitorRight)
        desiredLeft = monitorRight - menuWidth;
    if (Number.isFinite(monitorLeft) && desiredLeft < monitorLeft)
        desiredLeft = monitorLeft;

    const allocatedLeft = menuX - translationX;
    const offset = Math.round(desiredLeft - allocatedLeft);
    return Number.isFinite(offset) ? offset : null;
}
