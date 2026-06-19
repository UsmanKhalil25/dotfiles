return {
  "tiesen243/vercel.nvim",
  lazy = false,
  priority = 1000,
  config = function()
    require("vercel").setup({
      theme = "dark",
      transparent = false,
      italics = {
        comments = true,
        keywords = false,
        functions = false,
        strings = false,
        variables = false,
        bufferline = false,
      },
      overrides = {},
    })
    vim.cmd.colorscheme("vercel")
  end,
}
