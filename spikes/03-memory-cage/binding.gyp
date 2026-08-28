{
  "targets": [
    {
      "target_name": "cage",
      "sources": ["addon.c"],
      "conditions": [
        ["OS!='win'", { "defines": ["USE_MMAP"] }]
      ]
    }
  ]
}
