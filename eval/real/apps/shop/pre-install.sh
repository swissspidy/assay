#!/bin/sh
# PrestaShop's installer downloads language packs from i18n.prestashop-project.org.
# The evaluation container has no internet, so the packs are fetched once on the host
# (eval/real/apps.ts) and mounted at /tmp/assay-langpacks; this makes the installer
# copy them from there instead of downloading.
set -e
F=/var/www/html/classes/Language.php
grep -q assay-langpacks "$F" && exit 0
sed -i 's#^\(\s*\)\$file = self::getPathToCachedTranslationPack(\$locale, \$type);#&\n\1$assayLocal = "/tmp/assay-langpacks/" . ((self::PACK_TYPE_EMAILS === $type) ? "mails" : "translations") . "/" . $locale . ".zip";\n\1if (is_file($assayLocal)) { return copy($assayLocal, $file); }#' "$F"
grep -q assay-langpacks "$F"
