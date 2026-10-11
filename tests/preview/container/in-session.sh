#!/usr/bin/env bash
# Inside the container's own session bus: the host's dconf, the headless shell
# on a virtual monitor like the host's, a few windows and a tray icon, then the
# shot driver.
set -uo pipefail

OUT="${PREVIEW_OUT:-/tmp/preview-out}"
LOGS="$OUT/logs"
mkdir -p "$LOGS"
P=/preview/container

# A headless mutter composites only while PipeWire carries frames, and the
# RemoteDesktop clicks need a ScreenCast stream to be absolute within.
pipewire >"$LOGS/pipewire.log" 2>&1 &
wireplumber >"$LOGS/wireplumber.log" 2>&1 &
sleep 2

# The host's dconf, one dump per path (file name = path with / turned into .).
for dump in /host/dconf/*.ini; do
    path="/$(basename "$dump" .ini | tr . /)/"
    dconf load "$path" <"$dump" || echo "   dconf load $path failed"
done
# The wallpaper files run.sh copied: the host's own paths mean nothing in here.
for variant in picture-uri:light picture-uri-dark:dark; do
    file="$(compgen -G "/host/wallpaper/${variant#*:}/*" | head -1)"
    [[ -n "$file" ]] && gsettings set org.gnome.desktop.background "${variant%%:*}" "file://$file"
done
# The extensions run.sh staged, in the host's order, and the container-only
# hook last; no version gate (as in Pear Up's harness), no "what's new" dialog.
uuids=()
[[ -f /host/extensions.txt ]] && mapfile -t uuids </host/extensions.txt
uuids+=(pear-up-preview-hook@localhost)
list="$(printf "'%s', " "${uuids[@]}")"
gsettings set org.gnome.shell enabled-extensions "[${list%, }]"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell disable-extension-version-validation true
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
dconf dump / >"$LOGS/dconf-effective.ini"

gnome-shell --headless --no-x11 --virtual-monitor "${PREVIEW_SIZE:-2880x1920}" >"$LOGS/shell.log" 2>&1 &
SHELL_PID=$!

eval_js() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>/dev/null
}

# Up once Eval answers, which needs the hook enabled, which comes after all of
# the host's extensions in the enabled list.
for _ in $(seq 1 120); do
    if eval_js 'typeof pv' | grep -q "true, '\"object\"'"; then
        break
    fi
    if ! kill -0 $SHELL_PID 2>/dev/null; then
        echo "FAIL: the shell exited while starting"
        tail -40 "$LOGS/shell.log"
        exit 1
    fi
    sleep 1
done
if ! eval_js 'typeof pv' | grep -q "true, '\"object\"'"; then
    echo "FAIL: the shell came up without the preview hook"
    tail -40 "$LOGS/shell.log"
    exit 1
fi
echo "   shell up"
sleep 4

# Windows, launched by the shell itself so they carry its environment and are
# tracked as apps; the front app last.
FRONT="${PREVIEW_FRONT_APP:-org.gnome.Nautilus.desktop}"
for app in org.gnome.Calculator.desktop org.gnome.TextEditor.desktop \
           io.github.maddinek.PearUpTestWindow.desktop "$FRONT"; do
    eval_js "(() => { const a = pv.Shell.AppSystem.get_default().lookup_app('$app');
                      if (!a) return 'missing'; a.activate(); return 'ok'; })()" \
        | grep -q missing && echo "   no app $app"
    sleep 2
done
python3 "$P/tray-icon.py" "${PREVIEW_TRAY_ICON:-applications-system}" >"$LOGS/tray.log" 2>&1 &

# Wait for the windows, then lay them out the way a desk might look: helpers
# behind, the front app in the middle. The rectangles are x, y, width, height on
# a 1440x960 stage and scale with the real one.
for _ in $(seq 1 30); do
    n="$(eval_js 'global.get_window_actors().filter(a => a.meta_window.get_window_type() === 0).length' \
        | sed -n "s/.*'\([0-9]*\)'.*/\1/p")"
    [[ "${n:-0}" -ge 4 ]] && break
    sleep 1
done
echo "   ${n:-0} windows"
eval_js "
(() => {
  const sx = global.stage.width / 1440, sy = global.stage.height / 960;
  const place = {
    'org.gnome.Calculator': [60, 110, 360, 560],
    'org.gnome.TextEditor': [640, 80, 700, 560],
    'io.github.maddinek.PearUpTestWindow': [120, 470, 600, 400],
    '${FRONT%.desktop}': [190, 150, 1000, 640],
  };
  for (const a of global.get_window_actors()) {
    const w = a.meta_window;
    const id = w.get_gtk_application_id() || w.get_wm_class();
    const r = place[id];
    if (!r) continue;
    if (w.get_maximized?.()) w.unmaximize?.(3);
    w.move_resize_frame(false, Math.round(r[0] * sx), Math.round(r[1] * sy),
                        Math.round(r[2] * sx), Math.round(r[3] * sy));
  }
  return true;
})()" >/dev/null
sleep 3

read -ra shots <<<"${PREVIEW_SHOTS:-}"
python3 -u "$P/driver.py" "$OUT" "${shots[@]}" 2>&1 | tee "$LOGS/driver.log"
status=${PIPESTATUS[0]}

if [[ "${PREVIEW_HOLD:-0}" == "1" ]]; then
    # For poking at: DBUS_SESSION_BUS_ADDRESS=$(cat /tmp/preview-bus) as the user.
    echo "$DBUS_SESSION_BUS_ADDRESS" >/tmp/preview-bus
    echo "   holding the session (PREVIEW_HOLD=1)"
    sleep infinity
fi

kill $SHELL_PID 2>/dev/null
wait $SHELL_PID 2>/dev/null
exit "$status"
