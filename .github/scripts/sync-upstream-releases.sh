#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO="${SOURCE_REPO:-mekos2772/ios-location-spoofer}"
TARGET_REPO="${TARGET_REPO:-${GITHUB_REPOSITORY:-6mb/ios-location-spoofer}}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

release_rows="$tmp_dir/releases.b64"
latest_tag=""

if latest_json="$(gh release view --repo "$SOURCE_REPO" --json tagName 2>/dev/null)"; then
  latest_tag="$(jq -r '.tagName // ""' <<<"$latest_json")"
fi

echo "Syncing releases from $SOURCE_REPO to $TARGET_REPO"
echo "Source latest release: ${latest_tag:-none}"

gh release list --repo "$SOURCE_REPO" --limit 300 --json tagName > "$tmp_dir/release-tags.json"
jq -r '.[].tagName' "$tmp_dir/release-tags.json" | while IFS= read -r tag; do
  gh release view "$tag" \
    --repo "$SOURCE_REPO" \
    --json tagName,name,isDraft,isPrerelease,body,assets,targetCommitish \
    | base64 -w 0
  printf '\n'
done > "$release_rows"

if [ ! -s "$release_rows" ]; then
  echo "No source releases found."
  exit 0
fi

decode_release() {
  printf '%s' "$1" | base64 -d
}

release_exists() {
  local tag="$1"
  gh release view "$tag" --repo "$TARGET_REPO" >/dev/null 2>&1
}

retry() {
  local max_attempts="$1"
  shift
  local attempt=1

  until "$@"; do
    if [ "$attempt" -ge "$max_attempts" ]; then
      return 1
    fi

    sleep $((attempt * 2))
    attempt=$((attempt + 1))
  done
}

tac "$release_rows" | while IFS= read -r row; do
  release_json="$(decode_release "$row")"
  tag="$(jq -r '.tagName' <<<"$release_json")"
  name="$(jq -r '.name // .tagName' <<<"$release_json")"
  draft="$(jq -r '.isDraft' <<<"$release_json")"
  prerelease="$(jq -r '.isPrerelease' <<<"$release_json")"
  body_file="$tmp_dir/release-body-${tag//[^A-Za-z0-9._-]/_}.md"

  jq -r '.body // ""' <<<"$release_json" > "$body_file"

  echo "::group::Release $tag"

  if release_exists "$tag"; then
    echo "Updating release metadata for $tag"
    gh release edit "$tag" \
      --repo "$TARGET_REPO" \
      --title "$name" \
      --notes-file "$body_file" \
      "--draft=$draft" \
      "--prerelease=$prerelease"

    if [ -n "$latest_tag" ] && [ "$tag" = "$latest_tag" ] && [ "$draft" != "true" ] && [ "$prerelease" != "true" ]; then
      gh release edit "$tag" --repo "$TARGET_REPO" --latest
    fi
  else
    echo "Creating release $tag"
    create_args=(
      release create "$tag"
      --repo "$TARGET_REPO"
      --title "$name"
      --notes-file "$body_file"
      --verify-tag
    )

    if [ "$draft" = "true" ]; then
      create_args+=(--draft)
    fi

    if [ "$prerelease" = "true" ]; then
      create_args+=(--prerelease)
    fi

    if [ -n "$latest_tag" ] && [ "$tag" = "$latest_tag" ] && [ "$draft" != "true" ] && [ "$prerelease" != "true" ]; then
      create_args+=(--latest)
    else
      create_args+=(--latest=false)
    fi

    gh "${create_args[@]}"
  fi

  jq -c '.assets[]?' <<<"$release_json" | while IFS= read -r asset_json; do
    asset_name="$(jq -r '.name' <<<"$asset_json")"
    asset_size="$(jq -r '.size' <<<"$asset_json")"
    asset_url="$(jq -r '.url' <<<"$asset_json")"
    asset_path="$tmp_dir/assets/${tag//[^A-Za-z0-9._-]/_}/$asset_name"
    mkdir -p "$(dirname "$asset_path")"

    target_size="$(
      gh release view "$tag" --repo "$TARGET_REPO" --json assets \
        --jq ".assets[]? | select(.name == \"$asset_name\") | .size" \
        | head -n 1
    )"

    if [ -n "$target_size" ] && [ "$target_size" = "$asset_size" ]; then
      echo "Asset already current: $asset_name"
      continue
    fi

    echo "Downloading asset: $asset_name"
    retry 5 curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors -o "$asset_path" "$asset_url"

    echo "Uploading asset: $asset_name"
    retry 5 gh release upload "$tag" "$asset_path" --repo "$TARGET_REPO" --clobber
  done

  echo "::endgroup::"
done

echo "Release sync complete."
