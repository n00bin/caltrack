"""Builds the offline food database the app ships with.

    python tools/build-food-db.py "<path to FoodData_Central_csv_YYYY-MM-DD>"

Why this exists: searching by name needed a USDA API key and a working
connection, and USDA answers a transient 400 to about one request in five.
Neither is acceptable for something you do standing in a kitchen. USDA also
publishes the whole thing as a bulk download, so the useful part can be
shipped with the app instead.

WHICH PART. Two of the four datasets:

  Survey (FNDDS)  whole dishes as people eat them - "Cheeseburger
                  (McDonalds)", "General Tso chicken" - with household
                  portions. This is the one that makes takeaways loggable.
  SR Legacy       raw and basic ingredients: chicken breast, rice, butter.

Branded is deliberately left out. It is 954 MB of packaged goods on its own,
and the barcode scanner already covers packets far better than a name search
could.

The output keeps four nutrients and the portions, as arrays rather than
objects, because field names repeated fifteen thousand times are most of the
file. Roughly 2 MB, which the service worker then caches.
"""
import csv
import io
import json
import os
import sys

# nutrient.csv ids. The nutrient_nbr equivalents are 208/203/205/204.
KCAL, PROTEIN, FAT, CARBS = '1008', '1003', '1004', '1005'
WANTED_NUTRIENTS = {KCAL, PROTEIN, FAT, CARBS}

SURVEY, LEGACY = 0, 1

# csv fields here can exceed the default limit.
csv.field_size_limit(min(sys.maxsize, 2147483647))


def rows(path):
    with io.open(path, encoding='utf-8', newline='') as fh:
        for row in csv.DictReader(fh):
            yield row


def wanted_ids(root):
    """fdc_id -> which dataset it came from."""
    out = {}
    for row in rows(os.path.join(root, 'survey_fndds_food.csv')):
        out[row['fdc_id']] = SURVEY
    for row in rows(os.path.join(root, 'sr_legacy_food.csv')):
        out[row['fdc_id']] = LEGACY
    return out


def descriptions(root, ids):
    out = {}
    for row in rows(os.path.join(root, 'food.csv')):
        if row['fdc_id'] in ids:
            out[row['fdc_id']] = row['description'].strip()
    return out


def nutrients(root, ids):
    """Streams the 1.8 GB file, keeping four nutrients for wanted foods."""
    out = {}
    path = os.path.join(root, 'food_nutrient.csv')
    total = os.path.getsize(path)
    read = 0
    with io.open(path, encoding='utf-8', newline='') as fh:
        header = fh.readline()
        read += len(header)
        for line in fh:
            read += len(line)
            # A cheap substring test before paying for a CSV parse: the vast
            # majority of these 25 million rows are nutrients we do not want.
            if ('"1008"' not in line and '"1003"' not in line
                    and '"1004"' not in line and '"1005"' not in line):
                continue
            parts = next(csv.reader([line]))
            fdc_id, nutrient_id, amount = parts[1], parts[2], parts[3]
            if nutrient_id not in WANTED_NUTRIENTS or fdc_id not in ids:
                continue
            try:
                out.setdefault(fdc_id, {})[nutrient_id] = float(amount)
            except ValueError:
                pass
            if read % (200 * 1024 * 1024) < len(line):
                sys.stdout.write('    %d%%\r' % (100 * read / total))
                sys.stdout.flush()
    return out


def portions(root, ids):
    """Portions normalised to the weight of ONE of the thing named."""
    out = {}
    for row in rows(os.path.join(root, 'food_portion.csv')):
        fdc_id = row['fdc_id']
        if fdc_id not in ids:
            continue
        try:
            grams = float(row['gram_weight'] or 0)
            amount = float(row['amount'] or 1) or 1
        except ValueError:
            continue
        if grams <= 0:
            continue

        label = (row.get('portion_description') or '').strip()
        if 'quantity not specified' in label.lower():
            continue
        if not label:
            label = (row.get('modifier') or '').strip()
        if not label:
            continue

        # "1 nugget" describes one of a thing, so the thing is the name.
        if label[:2] == '1 ':
            label = label[2:]
        # Half a cup weighing 60 g means a cup weighs 120.
        per_one = grams / amount
        if per_one <= 0 or per_one > 5000:
            continue

        out.setdefault(fdc_id, []).append([label.lower()[:30], round(per_one, 1)])
    return out


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    root = sys.argv[1]
    if not os.path.isdir(root):
        raise SystemExit('not a directory: ' + root)

    print('reading the food lists...')
    ids = wanted_ids(root)
    print('   %d foods wanted' % len(ids))

    print('reading descriptions...')
    names = descriptions(root, ids)
    print('   %d found' % len(names))

    print('reading portions...')
    ports = portions(root, ids)
    print('   %d foods have portions' % len(ports))

    print('streaming nutrients (this is the slow one)...')
    nuts = nutrients(root, ids)
    print('   %d foods have nutrients' % len(nuts))

    foods = []
    for fdc_id, dataset in ids.items():
        name = names.get(fdc_id)
        n = nuts.get(fdc_id)
        if not name or not n:
            continue
        kcal = n.get(KCAL)
        # A food with no calories cannot be logged, so it is not worth shipping.
        if not kcal:
            continue
        foods.append([
            name,
            round(kcal, 1),
            round(n.get(PROTEIN, 0), 2),
            round(n.get(CARBS, 0), 2),
            round(n.get(FAT, 0), 2),
            ports.get(fdc_id, [])[:4],
            dataset
        ])

    # Whole dishes first, then ingredients, alphabetical within each - so the
    # shipped order is already a sensible tie-break for search.
    foods.sort(key=lambda f: (f[6], f[0].lower()))

    out = {
        'version': os.path.basename(root.rstrip('\\/')),
        'source': 'USDA FoodData Central, Survey (FNDDS) and SR Legacy',
        'fields': ['name', 'kcal', 'protein', 'carbs', 'fat', 'portions', 'dataset'],
        'foods': foods
    }

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.abspath(os.path.join(here, '..', 'food-db.json'))
    with io.open(dest, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))

    size = os.path.getsize(dest)
    print()
    print('wrote %s' % dest)
    print('  %d foods, %.1f MB' % (len(foods), size / 1024.0 / 1024.0))
    with_portions = sum(1 for f in foods if f[5])
    print('  %d of them carry a portion (%d%%)' % (
        with_portions, 100 * with_portions / max(1, len(foods))))


if __name__ == '__main__':
    main()
