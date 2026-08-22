#!/bin/sh
#
# DIIISCO CLI installer for macOS and Linux (spec §7.1).
#
#   curl -fsSL https://diiis.co/install.sh | sudo sh
#
# Downloads the release artifact for this machine, verifies its SHA-256 against
# the published SHA256SUMS, and installs it to /usr/local/bin — already on
# PATH by default on macOS and virtually every Linux distribution, no shell rc
# edit needed. That's a system-wide, root-owned directory, so the default
# install needs sudo; pass --user for a sudo-free install into ~/.local/bin
# instead (you'll then need to put that on PATH yourself, or pass
# --modify-path). No package manager, no Node.js, either way.
#
# On macOS this also installs DIIISCO Desktop by default — there is no Linux
# desktop build, so on Linux this only ever installs the CLI. The desktop app
# is downloaded as a .dmg, mounted, and DIIISCO.app is copied into
# /Applications (or ~/Applications with --user), same as dragging it there
# yourself. Pass --no-desktop to skip it and install just the CLI.
#
# Flags (each also an environment variable):
#
#   --version VERSION       DIIISCO_VERSION          release tag to install (default: latest)
#   --install-dir DIR       DIIISCO_INSTALL_DIR      where to put the binary (default: /usr/local/bin)
#   --user                   DIIISCO_USER=1           install to ~/.local/bin instead — no sudo needed
#   --no-desktop             DIIISCO_NO_DESKTOP=1     skip DIIISCO Desktop, install just the CLI
#   --modify-path            DIIISCO_MODIFY_PATH=1    append the PATH line to your shell rc file
#   --no-verify              DIIISCO_NO_VERIFY=1      skip checksum verification (unsupported)
#   --base-url URL           DIIISCO_BASE_URL         override the CLI release host (default: https://diiis.co/cli)
#   --desktop-base-url URL   DIIISCO_DESKTOP_BASE_URL override the desktop release host (default: https://diiis.co/desktop)
#   --help
#
# POSIX sh, shellcheck-clean, idempotent, and it never runs anything with sudo
# on your behalf: if a destination needs elevation the script tells you the
# command to run (re-invoke the whole pipe through sudo) rather than running
# it for you.

set -eu

# Self-hosted releases, laid out by diiisco-publish/scripts/collect.ts:
#   ${BASE_URL}/releases/<tag>/diiisco-<os>-<arch>[.exe]
#   ${BASE_URL}/releases/<tag>/SHA256SUMS
#   ${BASE_URL}/latest.json                       {"tag": "v1.2.3"}
BASE_URL="${DIIISCO_BASE_URL:-https://diiis.co/cli}"
# Desktop artifacts, laid out by the same collect.ts, flat (see electrobun's
# release.baseUrl convention):
#   ${DESKTOP_BASE_URL}/stable-macos-<arch>-DIIISCO.dmg
DESKTOP_BASE_URL="${DIIISCO_DESKTOP_BASE_URL:-https://diiis.co/desktop}"

VERSION="${DIIISCO_VERSION:-}"
INSTALL_DIR="${DIIISCO_INSTALL_DIR:-}"
USER_INSTALL="${DIIISCO_USER:-0}"
NO_DESKTOP="${DIIISCO_NO_DESKTOP:-0}"
MODIFY_PATH="${DIIISCO_MODIFY_PATH:-0}"
NO_VERIFY="${DIIISCO_NO_VERIFY:-0}"

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    BOLD=$(printf '\033[1m')
    DIM=$(printf '\033[2m')
    RED=$(printf '\033[31m')
    GREEN=$(printf '\033[32m')
    YELLOW=$(printf '\033[33m')
    RESET=$(printf '\033[0m')
else
    BOLD='' DIM='' RED='' GREEN='' YELLOW='' RESET=''
fi

say() { printf '%s\n' "$*"; }
info() { printf '%s%s%s\n' "$DIM" "$*" "$RESET"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }

die() {
    printf '%s✗%s %s\n' "$RED" "$RESET" "$1" >&2
    shift
    for hint in "$@"; do printf '  %s%s%s\n' "$DIM" "$hint" "$RESET" >&2; done
    exit 1
}

# Written out rather than read back from "$0": piped through `curl | sh` there
# is no script file to read.
usage() {
    cat <<'USAGE'
DIIISCO CLI installer for macOS and Linux.

  curl -fsSL https://diiis.co/install.sh | sudo sh

On macOS this also installs DIIISCO Desktop by default (no Linux desktop
build exists, so Linux only ever gets the CLI). Pass --no-desktop to skip it.

Options (each also settable as an environment variable):

  --version VERSION       DIIISCO_VERSION          release tag to install (default: latest)
  --install-dir DIR       DIIISCO_INSTALL_DIR      where to put the binary (default: /usr/local/bin)
  --user                   DIIISCO_USER=1           install to ~/.local/bin instead — no sudo needed
  --no-desktop             DIIISCO_NO_DESKTOP=1     skip DIIISCO Desktop, install just the CLI
  --modify-path            DIIISCO_MODIFY_PATH=1    append the PATH line to your shell rc file
  --no-verify              DIIISCO_NO_VERIFY=1      skip checksum verification (unsupported)
  --base-url URL           DIIISCO_BASE_URL         override the CLI release host (default: https://diiis.co/cli)
  --desktop-base-url URL   DIIISCO_DESKTOP_BASE_URL override the desktop release host (default: https://diiis.co/desktop)
  -h, --help               this message

Passing flags through a pipe needs an explicit separator:

  curl -fsSL https://diiis.co/install.sh | sh -s -- --user --no-desktop --modify-path
USAGE
    exit 0
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            [ $# -ge 2 ] || die "--version needs a value, e.g. --version v1.2.3"
            VERSION="$2"
            shift 2
            ;;
        --version=*) VERSION="${1#--version=}"; shift ;;
        --install-dir)
            [ $# -ge 2 ] || die "--install-dir needs a value, e.g. --install-dir ~/bin"
            INSTALL_DIR="$2"
            shift 2
            ;;
        --install-dir=*) INSTALL_DIR="${1#--install-dir=}"; shift ;;
        --user) USER_INSTALL=1; shift ;;
        --no-desktop) NO_DESKTOP=1; shift ;;
        --modify-path) MODIFY_PATH=1; shift ;;
        --no-verify) NO_VERIFY=1; shift ;;
        --base-url)
            [ $# -ge 2 ] || die "--base-url needs a value, e.g. --base-url http://localhost:8080"
            BASE_URL="$2"
            shift 2
            ;;
        --base-url=*) BASE_URL="${1#--base-url=}"; shift ;;
        --desktop-base-url)
            [ $# -ge 2 ] || die "--desktop-base-url needs a value, e.g. --desktop-base-url http://localhost:8080"
            DESKTOP_BASE_URL="$2"
            shift 2
            ;;
        --desktop-base-url=*) DESKTOP_BASE_URL="${1#--desktop-base-url=}"; shift ;;
        -h|--help) usage ;;
        *) die "Unknown option \"$1\"." "Run the installer with --help to see the supported flags." ;;
    esac
done

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

if have curl; then
    DOWNLOADER=curl
elif have wget; then
    DOWNLOADER=wget
else
    die "Neither curl nor wget is available." "Install one of them and re-run this script."
fi

# Fetch a URL to stdout. Fails loudly on an HTTP error rather than writing an
# HTML error page into the install directory.
fetch() {
    if [ "$DOWNLOADER" = curl ]; then
        curl -fsSL "$1"
    else
        wget -qO- "$1"
    fi
}

# Fetch a URL to a file.
fetch_to() {
    if [ "$DOWNLOADER" = curl ]; then
        curl -fsSL -o "$2" "$1"
    else
        wget -qO "$2" "$1"
    fi
}

# ---------------------------------------------------------------------------
# Target detection
# ---------------------------------------------------------------------------

detect_target() {
    os=$(uname -s)
    arch=$(uname -m)

    case "$os" in
        Darwin) os_name=darwin ;;
        Linux) os_name=linux ;;
        *)
            die "Unsupported operating system \"$os\"." \
                "This installer covers macOS and Linux." \
                "Windows builds are downloaded directly: ${BASE_URL}"
            ;;
    esac

    case "$arch" in
        arm64|aarch64) arch_name=arm64 ;;
        x86_64|amd64) arch_name=x64 ;;
        *)
            die "Unsupported architecture \"$arch\"." \
                "Prebuilt binaries exist for arm64 and x86_64." \
                "See ${BASE_URL}"
            ;;
    esac

    printf '%s-%s' "$os_name" "$arch_name"
}

TARGET=$(detect_target)
ARTIFACT="diiisco-${TARGET}"

# detect_target's os_name/arch_name don't survive its own $(...) subshell, so
# re-derive them from TARGET (always exactly "<os>-<arch>") wherever needed.
TARGET_OS="${TARGET%-*}"
TARGET_ARCH="${TARGET#*-}"

# Desktop is on by default, but only where a build actually exists: macOS.
# There's no Linux desktop build to opt into, so --no-desktop is the only
# thing that changes anything there — it's already off.
if [ "$NO_DESKTOP" = 1 ] || [ "$TARGET_OS" != darwin ]; then
    DESKTOP_INSTALL=0
else
    DESKTOP_INSTALL=1
fi

# ---------------------------------------------------------------------------
# Version resolution
# ---------------------------------------------------------------------------

resolve_version() {
    if [ -n "$VERSION" ]; then
        case "$VERSION" in
            v*) printf '%s' "$VERSION" ;;
            *) printf 'v%s' "$VERSION" ;;
        esac
        return
    fi

    # latest.json is {"tag": "v1.2.3"}; pull out the value without needing jq,
    # which is not universally installed.
    tag=$(fetch "${BASE_URL}/latest.json" 2>/dev/null | sed -n 's/.*"tag" *: *"\([^"]*\)".*/\1/p' | head -n 1)
    [ -n "$tag" ] || die \
        "Could not work out the latest DIIISCO release." \
        "Check your network, or pin a version: DIIISCO_VERSION=v1.2.3 sh install.sh" \
        "Releases: ${BASE_URL}"
    printf '%s' "$tag"
}

TAG=$(resolve_version)

# ---------------------------------------------------------------------------
# Install directory
# ---------------------------------------------------------------------------

if [ -z "$INSTALL_DIR" ]; then
    if [ "$USER_INSTALL" = 1 ]; then
        INSTALL_DIR="${HOME}/.local/bin"
    else
        INSTALL_DIR=/usr/local/bin
    fi
fi

# Expand a leading ~ so --install-dir=~/bin works when the shell did not (a
# quoted argument, or a value that came from an environment variable). The
# tildes here are match patterns, not paths to be expanded.
# shellcheck disable=SC2088
case "$INSTALL_DIR" in
    "~") INSTALL_DIR="$HOME" ;;
    "~/"*) INSTALL_DIR="${HOME}/${INSTALL_DIR#\~/}" ;;
esac

DESTINATION="${INSTALL_DIR}/diiisco"

if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
    die "Cannot create ${INSTALL_DIR}." \
        "Re-run the whole pipe through sudo: curl -fsSL https://diiis.co/install.sh | sudo sh" \
        "or install just for you, no sudo needed: sh install.sh --user"
fi

if [ ! -w "$INSTALL_DIR" ]; then
    die "${INSTALL_DIR} is not writable." \
        "This script never uses sudo on your behalf — re-run the whole pipe through sudo yourself:" \
        "  curl -fsSL https://diiis.co/install.sh | sudo sh" \
        "or install just for you, no sudo needed:" \
        "  sh install.sh --user"
fi

# ---------------------------------------------------------------------------
# Shadowing check (§9.4): warn before hiding a desktop-bundled diiisco
# ---------------------------------------------------------------------------

EXISTING=$(command -v diiisco 2>/dev/null || true)
if [ -n "$EXISTING" ] && [ "$EXISTING" != "$DESTINATION" ]; then
    EXISTING_VERSION=$("$EXISTING" version 2>/dev/null || echo "unknown version")
    case "$EXISTING_VERSION" in
        *desktop-bundled*)
            warn "DIIISCO Desktop already provides a diiisco on your PATH:"
            warn "  ${EXISTING}  (${EXISTING_VERSION})"
            warn "Installing to ${INSTALL_DIR} may shadow it, depending on PATH order."
            warn "That copy is updated by the desktop app; this one by re-running install.sh."
            ;;
        *)
            warn "Another diiisco is already on your PATH:"
            warn "  ${EXISTING}  (${EXISTING_VERSION})"
            warn "Installing to ${INSTALL_DIR} may shadow it, depending on PATH order."
            ;;
    esac
fi

# ---------------------------------------------------------------------------
# Download + verify
# ---------------------------------------------------------------------------

TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t diiisco)
DMG_MOUNT=""
cleanup() {
    if [ -n "$DMG_MOUNT" ]; then
        hdiutil detach "$DMG_MOUNT" >/dev/null 2>&1 || true
    fi
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

DOWNLOAD_BASE="${BASE_URL}/releases/${TAG}"

say ""
say "${BOLD}Installing DIIISCO CLI${RESET}"
info "  version  ${TAG}"
info "  target   ${TARGET}"
info "  into     ${INSTALL_DIR}"
say ""

info "Downloading ${ARTIFACT}…"
fetch_to "${DOWNLOAD_BASE}/${ARTIFACT}" "${TMP_DIR}/${ARTIFACT}" || die \
    "Could not download ${DOWNLOAD_BASE}/${ARTIFACT}." \
    "Check the version tag and that a build exists for ${TARGET}." \
    "Releases: ${BASE_URL}"

# Pick a checksum tool. macOS ships shasum; most Linux distributions ship
# sha256sum; either is fine.
if have sha256sum; then
    checksum_of() { sha256sum "$1" | cut -d' ' -f1; }
elif have shasum; then
    checksum_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
    checksum_of() { return 1; }
fi

verify_checksum() {
    if [ "$NO_VERIFY" = 1 ]; then
        warn "Skipping checksum verification (--no-verify). This is unsupported."
        return 0
    fi

    if ! checksum_of "${TMP_DIR}/${ARTIFACT}" >/dev/null 2>&1; then
        die "No sha256sum or shasum on this machine, so the download cannot be verified." \
            "Install one of them, or re-run with --no-verify (unsupported)."
    fi

    info "Verifying checksum…"
    fetch_to "${DOWNLOAD_BASE}/SHA256SUMS" "${TMP_DIR}/SHA256SUMS" || die \
        "Could not download ${DOWNLOAD_BASE}/SHA256SUMS." \
        "Refusing to install an unverified binary."

    expected=$(grep " ${ARTIFACT}\$" "${TMP_DIR}/SHA256SUMS" | cut -d' ' -f1 | head -n 1)
    [ -n "$expected" ] || die \
        "SHA256SUMS has no entry for ${ARTIFACT}." \
        "Refusing to install an unverified binary."

    actual=$(checksum_of "${TMP_DIR}/${ARTIFACT}")
    if [ "$expected" != "$actual" ]; then
        die "Checksum mismatch for ${ARTIFACT} — the download is corrupt or has been tampered with." \
            "expected ${expected}" \
            "got      ${actual}"
    fi
    ok "Checksum verified."
}

verify_checksum

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

chmod +x "${TMP_DIR}/${ARTIFACT}"

# Replace via a temporary name in the destination directory: `mv` onto a
# running binary fails with ETXTBSY on Linux, and this makes the swap atomic.
STAGED="${DESTINATION}.new-$$"
cp "${TMP_DIR}/${ARTIFACT}" "$STAGED"
chmod 755 "$STAGED"

if ! mv -f "$STAGED" "$DESTINATION"; then
    rm -f "$STAGED"
    die "Could not write ${DESTINATION}." "Is a DIIISCO node running from that binary? Stop it with: diiisco stop"
fi

# macOS quarantines anything downloaded through a browser; curl usually does not
# set the attribute, but clear it when it is there so the first run is not
# blocked by Gatekeeper.
if [ "$(uname -s)" = Darwin ] && have xattr; then
    xattr -d com.apple.quarantine "$DESTINATION" >/dev/null 2>&1 || true
fi

INSTALLED_VERSION=$("$DESTINATION" version 2>/dev/null || echo "")
if [ -z "$INSTALLED_VERSION" ]; then
    die "Installed ${DESTINATION}, but it does not run on this machine." \
        "Report this with the output of: uname -sm"
fi

ok "Installed ${INSTALLED_VERSION} to ${DESTINATION}"

# ---------------------------------------------------------------------------
# PATH
# ---------------------------------------------------------------------------

on_path() {
    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*) return 0 ;;
        *) return 1 ;;
    esac
}

# The rc file and the syntax both depend on the shell, so detect it from $SHELL
# rather than guessing.
shell_profile() {
    case "$(basename "${SHELL:-sh}")" in
        zsh) printf '%s/.zshrc' "$HOME" ;;
        bash)
            if [ -f "${HOME}/.bashrc" ]; then printf '%s/.bashrc' "$HOME"
            else printf '%s/.bash_profile' "$HOME"
            fi
            ;;
        fish) printf '%s/.config/fish/config.fish' "$HOME" ;;
        *) printf '%s/.profile' "$HOME" ;;
    esac
}

path_line() {
    if [ "$(basename "${SHELL:-sh}")" = fish ]; then
        printf 'fish_add_path %s' "$INSTALL_DIR"
    else
        # $PATH is deliberately literal: this line is printed for the user to
        # paste into their rc file, not evaluated here.
        # shellcheck disable=SC2016
        printf 'export PATH="%s:$PATH"' "$INSTALL_DIR"
    fi
}

if ! on_path; then
    PROFILE=$(shell_profile)
    LINE=$(path_line)

    if [ "$MODIFY_PATH" = 1 ]; then
        mkdir -p "$(dirname "$PROFILE")"
        # Idempotent: re-running the installer must not stack duplicate lines.
        if [ -f "$PROFILE" ] && grep -qF "$INSTALL_DIR" "$PROFILE"; then
            info "${PROFILE} already references ${INSTALL_DIR}."
        else
            printf '\n# Added by the DIIISCO CLI installer\n%s\n' "$LINE" >>"$PROFILE"
            ok "Added ${INSTALL_DIR} to your PATH in ${PROFILE}."
        fi
        say ""
        info "Open a new terminal, or run: . ${PROFILE}"
    else
        say ""
        warn "${INSTALL_DIR} is not on your PATH."
        say "  Add it by putting this line in ${PROFILE}:"
        say ""
        say "    ${BOLD}${LINE}${RESET}"
        say ""
        info "  Or re-run this installer with --modify-path to do it for you."
    fi
fi

# ---------------------------------------------------------------------------
# Desktop app (macOS only, on by default — see DESKTOP_INSTALL above)
# ---------------------------------------------------------------------------

if [ "$DESKTOP_INSTALL" = 1 ]; then
    APPS_DIR="${DIIISCO_APPS_DIR:-}"
    if [ -z "$APPS_DIR" ]; then
        if [ "$USER_INSTALL" = 1 ]; then
            APPS_DIR="${HOME}/Applications"
        else
            APPS_DIR="/Applications"
        fi
    fi

    mkdir -p "$APPS_DIR" 2>/dev/null || die \
        "Cannot create ${APPS_DIR}." \
        "Install just for you instead: sh install.sh --user" \
        "or point at a directory you own: DIIISCO_APPS_DIR=DIR sh install.sh"

    if [ ! -w "$APPS_DIR" ]; then
        die "${APPS_DIR} is not writable." \
            "This script never uses sudo on your behalf — re-run the whole pipe through sudo yourself:" \
            "  curl -fsSL https://diiis.co/install.sh | sudo sh" \
            "or install just for you, no sudo needed:" \
            "  sh install.sh --user"
    fi

    DESKTOP_ARTIFACT="stable-macos-${TARGET_ARCH}-DIIISCO.dmg"
    DESKTOP_URL="${DESKTOP_BASE_URL}/${DESKTOP_ARTIFACT}"

    say ""
    say "${BOLD}Installing DIIISCO Desktop${RESET}"
    info "  target   macos-${TARGET_ARCH}"
    info "  into     ${APPS_DIR}/DIIISCO.app"
    say ""

    info "Downloading ${DESKTOP_ARTIFACT}…"
    fetch_to "$DESKTOP_URL" "${TMP_DIR}/${DESKTOP_ARTIFACT}" || die \
        "Could not download ${DESKTOP_URL}." \
        "Check that a desktop build exists for macos-${TARGET_ARCH}." \
        "Releases: ${DESKTOP_BASE_URL}"

    DMG_MOUNT="${TMP_DIR}/dmg"
    mkdir -p "$DMG_MOUNT"
    hdiutil attach -nobrowse -readonly -mountpoint "$DMG_MOUNT" "${TMP_DIR}/${DESKTOP_ARTIFACT}" >/dev/null || die \
        "Could not mount ${DESKTOP_ARTIFACT}." "It may be corrupt — try re-running the installer."

    [ -d "${DMG_MOUNT}/DIIISCO.app" ] || die "${DESKTOP_ARTIFACT} does not contain DIIISCO.app."

    # No SHA256SUMS is published for the desktop .dmg (unlike the CLI binary
    # above) — the app bundle's own code signature is the equivalent integrity
    # check here. An unsigned build is a supported fallback elsewhere in this
    # pipeline, so a failed/missing signature warns rather than blocks install.
    if [ "$NO_VERIFY" != 1 ] && have codesign; then
        info "Verifying code signature…"
        if codesign --verify --deep --strict "${DMG_MOUNT}/DIIISCO.app" 2>/dev/null; then
            ok "Code signature verified."
        else
            warn "DIIISCO.app's code signature did not verify — installing anyway."
            warn "This is expected for an unsigned build; Gatekeeper may warn on first launch."
        fi
    fi

    rm -rf "${APPS_DIR}/DIIISCO.app"
    cp -R "${DMG_MOUNT}/DIIISCO.app" "${APPS_DIR}/DIIISCO.app"

    hdiutil detach "$DMG_MOUNT" >/dev/null 2>&1 || true
    DMG_MOUNT=""

    # DIIISCO.app is a self-extracting stub: first launch unpacks the real app
    # in place (writing new files into its own bundle), then relaunches. Under
    # sudo that copy above just made it root-owned, and a normal (non-root)
    # double-click can never write into it — the launcher spins at ~100% CPU
    # forever and no window ever appears. Hand it back to whoever ran sudo, since
    # that's who's going to double-click it.
    if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
        chown -R "$SUDO_USER" "${APPS_DIR}/DIIISCO.app"
    fi

    if have xattr; then
        xattr -dr com.apple.quarantine "${APPS_DIR}/DIIISCO.app" >/dev/null 2>&1 || true
    fi

    ok "Installed DIIISCO Desktop to ${APPS_DIR}/DIIISCO.app"
fi

# ---------------------------------------------------------------------------
# Next steps (§3.3: there is no zero-config run)
# ---------------------------------------------------------------------------

say ""
say "${BOLD}Next steps${RESET}"
say ""
say "  1. ${BOLD}diiisco setup${RESET}          create your configuration"
say "  2. ${BOLD}diiisco launch claude${RESET}  start a node and point Claude Code at it"
say ""
info "  diiisco help  for the full command list"
say ""
