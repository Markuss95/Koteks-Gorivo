// pdfmake ships its renderer and bundled fonts as separate build files without
// first-class types; declare them as `any` so we can lazy-import them.
declare module 'pdfmake/build/pdfmake';
declare module 'pdfmake/build/vfs_fonts';
