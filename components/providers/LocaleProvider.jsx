"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import enCommon from "../../public/locales/en/common.json";
import esCommon from "../../public/locales/es/common.json";
import frCommon from "../../public/locales/fr/common.json";
import deCommon from "../../public/locales/de/common.json";

const DEFAULT_LOCALE = "en";
const STORAGE_KEY = "vaultquest-locale";
const SUPPORTED_LOCALES = ["en", "es", "fr", "de"];
const resources = {
  en: { common: enCommon },
  es: { common: esCommon },
  fr: { common: frCommon },
  de: { common: deCommon },
};
const LocaleContext = createContext(null);

function isSupportedLocale(locale) {
  return SUPPORTED_LOCALES.includes(locale);
}

export default function LocaleProvider({ children }) {
  const [locale, setLocaleState] = useState(DEFAULT_LOCALE);
  const [i18n] = useState(() => {
    const instance = createInstance();
    instance.use(initReactI18next).init({
      resources,
      lng: DEFAULT_LOCALE,
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: SUPPORTED_LOCALES,
      defaultNS: "common",
      ns: ["common"],
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
      initImmediate: false,
    });
    return instance;
  });

  const setLocale = useCallback((nextLocale) => {
    if (!isSupportedLocale(nextLocale)) return;
    setLocaleState(nextLocale);
    void i18n.changeLanguage(nextLocale);
    document.documentElement.lang = nextLocale;
    try {
      window.localStorage.setItem(STORAGE_KEY, nextLocale);
    } catch {}
  }, [i18n]);

  useEffect(() => {
    let storedLocale = null;
    try {
      storedLocale = window.localStorage.getItem(STORAGE_KEY);
    } catch {}
    const initialLocale = isSupportedLocale(storedLocale) ? storedLocale : DEFAULT_LOCALE;
    setLocaleState(initialLocale);
    void i18n.changeLanguage(initialLocale);
    document.documentElement.lang = initialLocale;
  }, [i18n]);

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error("useLocale must be used inside LocaleProvider");
  return context;
}
