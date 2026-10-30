/* ================================================================
   KDPEasy A+ Image Fitter — presets.js

   THE LIST OF A+ CONTENT MODULES AND THEIR IMAGE SLOTS.
   This is the only file you need to touch when a number changes.
   (app.js reads this list and never contains any module sizes.)

   Sizes below were checked by hand in KDP's real A+ Content Manager
   on 2026-10-30. They are the MINIMUM pixel size of each image slot.
   KDP accepts bigger images and lets the customer pan/zoom inside a
   frame of the slot's shape. Do not replace them with numbers from blogs.

   HOW TO FIX A NUMBER (GitHub web editor):
     1. Find the module below.
     2. Change  w  (width in pixels) and/or  h  (height in pixels).
     3. If you have now checked it in KDP yourself, change
        confirmed: false   to   confirmed: true
     4. Commit. Nothing else needs to change.

   FIELDS
     slug       Short lowercase name used in the download file name
                (aplus-<slug>-<slot slug>-<W>x<H>.png). Letters, numbers, dashes.
     name       The module name as customers see it in KDP.
     confirmed  true  = size verified in KDP's editor.
                false = NOT verified yet; the tool shows an "Unconfirmed size" tag.
     note       Optional. One extra sentence shown with the "Unconfirmed size" tag.
     slots      One entry per image the module needs:
                  slug   short lowercase name for the file name
                  label  what the customer sees ("Image 1", "Main image"...)
                  w, h   minimum width and height in pixels
   ================================================================ */
window.APLUS_PRESETS = [

  {
    slug: 'header-with-text',
    name: 'Standard Image Header With Text',
    confirmed: true,
    slots: [
      { slug: 'main', label: 'Header image', w: 970, h: 600 }
    ]
  },

  {
    slug: 'dark-text-overlay',
    name: 'Standard Image & Dark Text Overlay (background)',
    confirmed: true,
    slots: [
      { slug: 'main', label: 'Background image', w: 970, h: 300 }
    ]
  },

  {
    slug: 'light-text-overlay',
    name: 'Standard Image & Light Text Overlay (background)',
    confirmed: false,                       // assumed to be the same as the Dark version
    slots: [
      { slug: 'main', label: 'Background image', w: 970, h: 300 }
    ]
  },

  {
    slug: 'three-images',
    name: 'Standard Three Images & Text',
    confirmed: true,
    slots: [
      { slug: 'image-1', label: 'Image 1', w: 300, h: 300 },
      { slug: 'image-2', label: 'Image 2', w: 300, h: 300 },
      { slug: 'image-3', label: 'Image 3', w: 300, h: 300 }
    ]
  },

  {
    slug: 'four-images',
    name: 'Standard Four Image & Text',
    confirmed: true,
    slots: [
      { slug: 'image-1', label: 'Image 1', w: 220, h: 220 },
      { slug: 'image-2', label: 'Image 2', w: 220, h: 220 },
      { slug: 'image-3', label: 'Image 3', w: 220, h: 220 },
      { slug: 'image-4', label: 'Image 4', w: 220, h: 220 }
    ]
  },

  {
    slug: 'four-image-quadrant',
    name: 'Standard Four Image/Text Quadrant',
    confirmed: true,
    slots: [
      { slug: 'image-1', label: 'Image 1', w: 135, h: 135 },
      { slug: 'image-2', label: 'Image 2', w: 135, h: 135 },
      { slug: 'image-3', label: 'Image 3', w: 135, h: 135 },
      { slug: 'image-4', label: 'Image 4', w: 135, h: 135 }
    ]
  },

  {
    slug: 'single-left-image',
    name: 'Standard Single Left Image',
    confirmed: true,
    slots: [
      { slug: 'main', label: 'Image', w: 300, h: 300 }
    ]
  },

  {
    slug: 'single-right-image',
    name: 'Standard Single Right Image',
    confirmed: false,                       // assumed to be the same as Single Left Image
    slots: [
      { slug: 'main', label: 'Image', w: 300, h: 300 }
    ]
  },

  {
    slug: 'single-highlights',
    name: 'Standard Single Image & Highlights',
    confirmed: true,
    slots: [
      { slug: 'main', label: 'Image', w: 300, h: 300 }
    ]
  },

  {
    slug: 'single-specs-detail',
    name: 'Standard Single Image & Specs Detail',
    confirmed: true,
    slots: [
      { slug: 'main', label: 'Image', w: 300, h: 300 }
    ]
  },

  {
    slug: 'single-sidebar',
    name: 'Standard Single Image & Sidebar',
    confirmed: true,
    slots: [
      { slug: 'main', label: 'Main image',    w: 300, h: 400 },
      { slug: 'side', label: 'Sidebar image', w: 350, h: 175 }
    ]
  },

  {
    slug: 'multiple-image-a',
    name: 'Standard Multiple Image Module A',
    confirmed: false,                       // only the first image was checked
    note: 'Only the first (big) image was checked in KDP. The extra thumbnails in this module were not.',
    slots: [
      { slug: 'main', label: 'First image', w: 300, h: 300 }
    ]
  },

  {
    slug: 'company-logo',
    name: 'Standard Company Logo',
    confirmed: false,                       // seen only on the module thumbnail
    slots: [
      { slug: 'main', label: 'Logo', w: 600, h: 180 }
    ]
  },

  {
    slug: 'comparison-chart',
    name: 'Standard Comparison Chart',
    confirmed: false,                       // from KDP's help page only
    slots: [
      { slug: 'main', label: 'Image', w: 150, h: 300 }
    ]
  }

];
