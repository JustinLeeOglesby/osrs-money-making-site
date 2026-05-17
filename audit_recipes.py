"""
Sanity check for osrs_herb_margins.py recipes against the live OSRS wiki.

What it does:
  1. Pulls the wiki's full /mapping (~4000 items with names + properties).
  2. Walks every Recipe in RECIPES and every Combination.
  3. For each ingredient (input or output) by item_id:
       - flags item_ids that don't exist in the mapping
       - flags item_ids whose name in the code doesn't match the wiki name
  4. Optionally surfaces "items in the wiki you might be missing" — pass
     keywords like:  python audit_recipes.py --suggest "sailing,camphor,huasca"
     and the script lists every wiki item containing one of those substrings
     so you can see what's likely in scope for your site but absent.

Why exist:
  The recipe IDs and names in osrs_herb_margins.py are hardcoded from the
  knowledge cutoff. OSRS gets balance + content patches constantly; the wiki
  is the source of truth. This script gives you a cheap audit pass.

Usage:
  python audit_recipes.py                          # full ID/name audit
  python audit_recipes.py --suggest "huasca,sail"  # plus item-name search
"""

import argparse
import sys
from typing import Iterable

import requests

from osrs_herb_margins import (
    BASE_URL,
    HEADERS,
    RECIPES,
    COMBINATIONS,
)


def fetch_mapping() -> dict[int, dict]:
    resp = requests.get(f"{BASE_URL}/mapping", headers=HEADERS, timeout=15)
    resp.raise_for_status()
    return {entry["id"]: entry for entry in resp.json()}


def iter_recipe_items() -> Iterable[tuple[str, str, int, str]]:
    """Yield (where, role, item_id, name_in_code) for every priced ingredient.

    `where` is a human-readable location ("recipe: <name>" or
    "combo: <name>"); `role` is "input" or "output".
    """
    for r in RECIPES:
        for ing in r.inputs:
            yield (f"recipe: {r.name}", "input", ing.item_id, ing.name)
        for out in r.outputs:
            yield (f"recipe: {r.name}", "output", out.item_id, out.name)
    for c in COMBINATIONS:
        for part in c.parts:
            yield (f"combo: {c.name}", "input", part.item_id, part.name)
        yield (f"combo: {c.name}", "output", c.whole.item_id, c.whole.name)


def normalize(s: str) -> str:
    """Loose name comparison — strip articles, parens, case."""
    return s.lower().replace("'", "").replace("(", "").replace(")", "").strip()


def audit(mapping: dict[int, dict]) -> tuple[list[str], list[str]]:
    """Returns (unknown_ids, name_mismatches) as lists of human-readable lines."""
    unknown = []
    mismatches = []
    seen = set()
    for where, role, iid, name in iter_recipe_items():
        key = (iid, name)
        if key in seen:
            continue
        seen.add(key)
        wiki = mapping.get(iid)
        if not wiki:
            unknown.append(f"  [{where}] {role} {iid} ({name!r}) — not in /mapping")
            continue
        if normalize(wiki["name"]) != normalize(name):
            mismatches.append(
                f"  [{where}] {role} {iid} — code says {name!r}, wiki says {wiki['name']!r}"
            )
    return unknown, mismatches


def find_by_keywords(mapping: dict[int, dict], keywords: list[str]) -> list[dict]:
    """Items whose name contains any of the keywords (case-insensitive)."""
    kws = [k.lower().strip() for k in keywords if k.strip()]
    return [
        item
        for item in mapping.values()
        if any(kw in item["name"].lower() for kw in kws)
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--suggest",
        help="Comma-separated keywords to search the wiki mapping for "
        "(e.g. 'sailing,camphor,huasca').",
        default="",
    )
    args = parser.parse_args()

    print("Fetching wiki /mapping…")
    mapping = fetch_mapping()
    print(f"Loaded {len(mapping)} items from wiki.\n")

    unknown, mismatches = audit(mapping)

    print(f"=== Unknown item IDs in code: {len(unknown)} ===")
    for line in unknown:
        print(line)
    if not unknown:
        print("  (none — every recipe ID resolves on the wiki) ✓")

    print(f"\n=== Name mismatches (code vs wiki): {len(mismatches)} ===")
    for line in mismatches:
        print(line)
    if not mismatches:
        print("  (none — every code name matches the wiki name) ✓")

    if args.suggest:
        kws = [k.strip() for k in args.suggest.split(",") if k.strip()]
        print(f"\n=== Wiki items matching {kws} ===")
        items = find_by_keywords(mapping, kws)
        existing_ids = {
            iid for _, _, iid, _ in iter_recipe_items() if iid is not None
        }
        for it in sorted(items, key=lambda x: x["name"].lower()):
            tag = "  in-code" if it["id"] in existing_ids else "MISSING "
            print(f"  [{tag}] id={it['id']:>6}  {it['name']}")

    return 0 if not unknown and not mismatches else 1


if __name__ == "__main__":
    sys.exit(main())
