// Pulsar — panel zasobnika systemowego (Windows).
// Neutralino pokazuje w zasobniku tylko surowe menu Win32 (bez stylów, bez zdarzenia kliknięcia ikony),
// więc ikonę i panel w stylu Pulsara wyświetla ten mały pomocnik (WinForms, kompilowany przez Add-Type
// w Windows PowerShell 5.1 → składnia C# 5: bez $"", ?. , => w składowych itd.).
// Komunikacja z Pulsarem przez stdin/stdout (os.spawnProcess), bez sieci:
//   stdin  ← "state|klucz=wartość\x1fklucz=wartość…", "hide", "quit"
//   stdout → "ready", "cmd:<id>", "panel:open", "error:<opis>"
// Pomocnik kończy się sam, gdy zniknie proces Pulsara albo zamknie się stdin.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace PulsarTray
{
    public static class Host
    {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        public static void Run(string dir, int parentPid)
        {
            try { SetProcessDPIAware(); } catch (Exception) { }
            try { Application.EnableVisualStyles(); } catch (Exception) { }
            try { Application.SetCompatibleTextRenderingDefault(false); } catch (Exception) { }
            TrayApp app = new TrayApp(dir, parentPid);
            Application.Run(app);
        }
    }

    public class TrayApp : ApplicationContext
    {
        readonly string dir;
        readonly int parentPid;
        readonly NotifyIcon icon;
        readonly PanelForm form;
        readonly System.Windows.Forms.Timer watch;
        readonly object outLock = new object();
        Stream stdout;
        bool quitting;

        public TrayApp(string dir, int parentPid)
        {
            this.dir = dir;
            this.parentPid = parentPid;
            try { stdout = Console.OpenStandardOutput(); } catch (Exception) { stdout = null; }

            form = new PanelForm(this);
            IntPtr h = form.Handle; // uchwyt potrzebny do BeginInvoke z wątku stdin
            if (h == IntPtr.Zero) { }

            icon = new NotifyIcon();
            icon.Icon = LoadIcon();
            icon.Text = "Pulsar";
            icon.MouseUp += OnIconMouseUp;
            icon.Visible = true;

            watch = new System.Windows.Forms.Timer();
            watch.Interval = 2000;
            watch.Tick += delegate { CheckParent(); };
            watch.Start();

            Thread t = new Thread(ReadLoop);
            t.IsBackground = true;
            t.Start();

            Send("ready");
        }

        Icon LoadIcon()
        {
            try
            {
                string p = Path.Combine(dir, "tray-icon.png");
                if (File.Exists(p))
                {
                    byte[] bytes = File.ReadAllBytes(p);
                    using (MemoryStream ms = new MemoryStream(bytes))
                    using (Image src = Image.FromStream(ms))
                    {
                        int sz = Math.Max(16, SystemInformation.SmallIconSize.Width);
                        using (Bitmap bmp = new Bitmap(sz, sz))
                        {
                            using (Graphics g = Graphics.FromImage(bmp))
                            {
                                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                                g.SmoothingMode = SmoothingMode.AntiAlias;
                                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                                g.DrawImage(src, new Rectangle(0, 0, sz, sz));
                            }
                            return Icon.FromHandle(bmp.GetHicon());
                        }
                    }
                }
            }
            catch (Exception) { }
            return SystemIcons.Application;
        }

        void OnIconMouseUp(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left && e.Button != MouseButtons.Right) return;
            if (form.Visible) { form.HidePanel(); return; }
            // klik w ikonę przy otwartym panelu najpierw go dezaktywuje (chowa) — nie otwieraj od razu ponownie
            if ((DateTime.UtcNow - form.LastHidden).TotalMilliseconds < 350) return;
            form.ShowPanel(Cursor.Position);
            Send("panel:open");
        }

        void ReadLoop()
        {
            try
            {
                StreamReader rd = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string line;
                while ((line = rd.ReadLine()) != null)
                {
                    string l = line;
                    if (l.Length == 0) continue;
                    try { form.BeginInvoke(new Action(delegate { HandleLine(l); })); } catch (Exception) { }
                }
            }
            catch (Exception) { }
            // stdin zamknięty → Pulsar zniknął
            try { form.BeginInvoke(new Action(delegate { Quit(); })); } catch (Exception) { Environment.Exit(0); }
        }

        void HandleLine(string l)
        {
            if (l == "quit") { Quit(); return; }
            if (l == "hide") { form.HidePanel(); return; }
            if (l.StartsWith("state|"))
            {
                Dictionary<string, string> d = new Dictionary<string, string>();
                string[] parts = l.Substring(6).Split('\x1f');
                for (int i = 0; i < parts.Length; i++)
                {
                    int eq = parts[i].IndexOf('=');
                    if (eq > 0) d[parts[i].Substring(0, eq)] = parts[i].Substring(eq + 1);
                }
                form.SetState(d);
                string tip = form.TipText();
                if (tip.Length > 63) tip = tip.Substring(0, 62) + "\u2026";
                try { icon.Text = tip; } catch (Exception) { }
            }
        }

        void CheckParent()
        {
            if (parentPid <= 0) return;
            try
            {
                Process p = Process.GetProcessById(parentPid);
                if (p.HasExited) Quit();
            }
            catch (ArgumentException) { Quit(); }
            catch (Exception) { }
        }

        public void Send(string s)
        {
            lock (outLock)
            {
                try
                {
                    if (stdout == null) return;
                    byte[] b = Encoding.UTF8.GetBytes(s + "\n");
                    stdout.Write(b, 0, b.Length);
                    stdout.Flush();
                }
                catch (Exception) { }
            }
        }

        public void Quit()
        {
            if (quitting) return;
            quitting = true;
            try { watch.Stop(); } catch (Exception) { }
            try { icon.Visible = false; icon.Dispose(); } catch (Exception) { }
            try { form.Close(); } catch (Exception) { }
            try { ExitThread(); } catch (Exception) { }
            Environment.Exit(0);
        }
    }

    public class PanelForm : Form
    {
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);

        class Item
        {
            public string Id;
            public Rectangle R;
            public int Kind; // 0 = okrągły przycisk, 1 = wiersz, 2 = wiersz z przełącznikiem, 3 = wiersz „Zakończ”
            public bool Enabled = true;
        }

        readonly TrayApp app;
        readonly float S;
        public DateTime LastHidden = DateTime.MinValue;

        string title = "", artist = "";
        bool playing, hasTracks, hidden, mini, onTop, closeToTray;
        double pos, dur;
        DateTime posAt = DateTime.UtcNow;
        Color accent = Color.FromArgb(160, 107, 255);
        Image cover;
        string coverKey = "";
        readonly Dictionary<string, string> L = new Dictionary<string, string>();

        readonly List<Item> items = new List<Item>();
        string hot, down;
        readonly System.Windows.Forms.Timer tick;

        readonly Font fTitle, fArtist, fRow, fSmall, fGlyph;
        static readonly Color BG = Color.FromArgb(24, 24, 24);
        static readonly Color TXT = Color.FromArgb(240, 240, 240);
        static readonly Color MUTED = Color.FromArgb(167, 167, 167);

        public PanelForm(TrayApp app)
        {
            this.app = app;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = BG;
            KeyPreview = true;
            Text = "Pulsar";
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            DoubleBuffered = true;
            using (Graphics g = CreateGraphics()) { S = g.DpiX / 96f; }
            if (S <= 0) S = 1f;

            fTitle = MakeFont("Segoe UI Semibold", 10.5f, FontStyle.Regular);
            fArtist = MakeFont("Segoe UI", 9f, FontStyle.Regular);
            fRow = MakeFont("Segoe UI", 9.5f, FontStyle.Regular);
            fSmall = MakeFont("Segoe UI", 8f, FontStyle.Regular);
            fGlyph = MakeFont("Segoe UI Symbol", 16f, FontStyle.Regular);

            L["nothing"] = "Nic nie gra"; L["show"] = "Poka\u017c okno"; L["hide"] = "Ukryj okno"; L["mini"] = "Tryb mini";
            L["ontop"] = "Zawsze na wierzchu"; L["closetray"] = "Zamykaj do zasobnika"; L["quit"] = "Zako\u0144cz";
            L["play"] = "Odtw\u00f3rz"; L["pause"] = "Pauza"; L["prev"] = "Poprzedni"; L["next"] = "Nast\u0119pny";

            Width = Sc(320);
            BuildLayout();

            tick = new System.Windows.Forms.Timer();
            tick.Interval = 500;
            tick.Tick += delegate { if (Visible && playing) Invalidate(); };
            tick.Start();
        }

        static Font MakeFont(string name, float size, FontStyle st)
        {
            try { return new Font(name, size, st); } catch (Exception) { return new Font(FontFamily.GenericSansSerif, size, st); }
        }

        int Sc(float v) { return (int)Math.Round(v * S); }
        Rectangle R(float x, float y, float w, float h) { return new Rectangle(Sc(x), Sc(y), Sc(w), Sc(h)); }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ClassStyle |= 0x00020000;  // CS_DROPSHADOW
                cp.ExStyle |= 0x00000080;     // WS_EX_TOOLWINDOW — bez ikony na pasku i w Alt+Tab
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int dark = 1; DwmSetWindowAttribute(Handle, 20, ref dark, 4);          // DWMWA_USE_IMMERSIVE_DARK_MODE
                int round = 2; DwmSetWindowAttribute(Handle, 33, ref round, 4);        // DWMWA_WINDOW_CORNER_PREFERENCE = ROUND (Windows 11)
                int border = 0x00333333; DwmSetWindowAttribute(Handle, 34, ref border, 4); // DWMWA_BORDER_COLOR
            }
            catch (Exception) { }
        }

        /* ---------- stan z Pulsara ---------- */
        static string G(Dictionary<string, string> d, string k) { string v; return d.TryGetValue(k, out v) ? v : ""; }
        static bool B(Dictionary<string, string> d, string k) { string v = G(d, k); return v == "1" || v == "true"; }
        static double N(Dictionary<string, string> d, string k)
        {
            double v; return double.TryParse(G(d, k), NumberStyles.Float, CultureInfo.InvariantCulture, out v) ? v : 0;
        }

        public void SetState(Dictionary<string, string> d)
        {
            title = G(d, "title"); artist = G(d, "artist");
            playing = B(d, "playing"); hasTracks = B(d, "hasTracks"); hidden = B(d, "hidden"); mini = B(d, "mini");
            onTop = B(d, "onTop"); closeToTray = B(d, "closeToTray");
            pos = N(d, "pos"); dur = N(d, "dur"); posAt = DateTime.UtcNow;
            foreach (KeyValuePair<string, string> kv in d)
                if (kv.Key.StartsWith("l_") && kv.Value.Length > 0) L[kv.Key.Substring(2)] = kv.Value;
            string acc = G(d, "accent");
            if (acc.Length > 0)
            {
                string[] p = acc.Split(',');
                int r, g, b;
                if (p.Length == 3 && int.TryParse(p[0].Trim(), out r) && int.TryParse(p[1].Trim(), out g) && int.TryParse(p[2].Trim(), out b))
                    accent = Color.FromArgb(Clamp(r), Clamp(g), Clamp(b));
            }
            string key = G(d, "coverKey"), path = G(d, "cover");
            if (key != coverKey)
            {
                coverKey = key;
                Image old = cover; cover = null;
                if (old != null) old.Dispose();
                if (path.Length > 0)
                {
                    try
                    {
                        byte[] bytes = File.ReadAllBytes(path);
                        using (MemoryStream ms = new MemoryStream(bytes))
                        using (Image img = Image.FromStream(ms)) { cover = new Bitmap(img); }
                    }
                    catch (Exception) { cover = null; }
                }
            }
            BuildLayout();
            Invalidate();
        }

        static int Clamp(int v) { return Math.Max(0, Math.Min(255, v)); }

        public string TipText()
        {
            if (title.Length == 0) return "Pulsar";
            return (playing ? "\u25B6 " : "") + title + (artist.Length > 0 ? " \u2014 " + artist : "");
        }

        /* ---------- układ ---------- */
        const float PAD = 14, ROW = 34;
        float rowsTop;

        void BuildLayout()
        {
            items.Clear();
            float w = Width / S;
            float cy = 132; // środek rzędu przycisków
            Add("prev", 0, R(w / 2 - 64 - 18, cy - 18, 36, 36), hasTracks);
            Add("toggle", 0, R(w / 2 - 22, cy - 22, 44, 44), hasTracks);
            Add("next", 0, R(w / 2 + 64 - 18, cy - 18, 36, 36), hasTracks);
            rowsTop = 170;
            float y = rowsTop;
            Add("show", 1, R(6, y, w - 12, ROW), true); y += ROW;
            Add("mini", 2, R(6, y, w - 12, ROW), true); y += ROW;
            Add("ontop", 2, R(6, y, w - 12, ROW), true); y += ROW;
            Add("closetray", 2, R(6, y, w - 12, ROW), true); y += ROW;
            y += 9;
            Add("quit", 3, R(6, y, w - 12, ROW), true); y += ROW;
            int h = Sc(y + 7);
            if (Height != h) Height = h;
        }

        void Add(string id, int kind, Rectangle r, bool enabled)
        {
            Item it = new Item(); it.Id = id; it.Kind = kind; it.R = r; it.Enabled = enabled; items.Add(it);
        }

        Item HitTest(Point p)
        {
            for (int i = 0; i < items.Count; i++) if (items[i].R.Contains(p)) return items[i];
            return null;
        }

        /* ---------- pokazywanie ---------- */
        public void ShowPanel(Point cursor)
        {
            BuildLayout();
            hot = null; down = null;
            Screen scr = Screen.FromPoint(cursor);
            Rectangle wa = scr.WorkingArea, b = scr.Bounds;
            int m = Sc(10);
            int x = cursor.X - Width / 2, y;
            if (wa.Bottom < b.Bottom) y = wa.Bottom - Height - m;          // pasek zadań na dole
            else if (wa.Top > b.Top) y = wa.Top + m;                        // na górze
            else y = cursor.Y - Height - m;
            if (wa.Right < b.Right) x = wa.Right - Width - m;              // z prawej
            else if (wa.Left > b.Left) x = wa.Left + m;                     // z lewej
            x = Math.Max(wa.Left + m, Math.Min(x, wa.Right - Width - m));
            y = Math.Max(wa.Top + m, Math.Min(y, wa.Bottom - Height - m));
            Location = new Point(x, y);
            Show();
            Activate();
            try { SetForegroundWindow(Handle); } catch (Exception) { }
            Invalidate();
        }

        public void HidePanel()
        {
            if (!Visible) return;
            Hide();
            LastHidden = DateTime.UtcNow;
        }

        protected override void OnDeactivate(EventArgs e) { base.OnDeactivate(e); HidePanel(); }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Escape) HidePanel();
            else if (e.KeyCode == Keys.Space && hasTracks) DoClick("toggle");
        }

        /* ---------- mysz ---------- */
        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            Item it = HitTest(e.Location);
            string h = (it != null && it.Enabled) ? it.Id : null;
            Cursor = h != null ? Cursors.Hand : Cursors.Default;
            if (h != hot) { hot = h; Invalidate(); }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (hot != null) { hot = null; Invalidate(); }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            Item it = HitTest(e.Location);
            down = (it != null && it.Enabled && e.Button == MouseButtons.Left) ? it.Id : null;
            Invalidate();
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            Item it = HitTest(e.Location);
            string d = down; down = null;
            if (it != null && it.Enabled && it.Id == d) DoClick(it.Id);
            Invalidate();
        }

        void DoClick(string id)
        {
            app.Send("cmd:" + id);
            // natychmiastowa odpowiedź w panelu; właściwy stan i tak przyjdzie z Pulsara
            if (id == "toggle") { if (playing) { pos = CurPos(); } playing = !playing; posAt = DateTime.UtcNow; }
            else if (id == "ontop") onTop = !onTop;
            else if (id == "closetray") closeToTray = !closeToTray;
            else if (id == "show" || id == "mini" || id == "quit") { HidePanel(); return; }
            Invalidate();
        }

        double CurPos()
        {
            double p = pos + (playing ? (DateTime.UtcNow - posAt).TotalSeconds : 0);
            if (dur > 0) p = Math.Min(p, dur);
            return Math.Max(0, p);
        }

        /* ---------- rysowanie ---------- */
        static GraphicsPath Round(RectangleF r, float rad)
        {
            GraphicsPath p = new GraphicsPath();
            float d = Math.Min(rad * 2, Math.Min(r.Width, r.Height));
            if (d <= 0.5f) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        static string Fmt(double s)
        {
            int t = (int)Math.Max(0, Math.Floor(s));
            return (t / 60).ToString(CultureInfo.InvariantCulture) + ":" + (t % 60).ToString("00", CultureInfo.InvariantCulture);
        }

        void Txt(Graphics g, string s, Font f, Rectangle r, Color c, TextFormatFlags extra)
        {
            TextRenderer.DrawText(g, s, f, r, c, TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis |
                TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | extra);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(BG);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            // delikatna poświata akcentu u góry (jak tło odtwarzacza)
            Rectangle glow = new Rectangle(0, 0, Width, Sc(110));
            using (LinearGradientBrush gb = new LinearGradientBrush(glow, Color.FromArgb(38, accent), Color.FromArgb(0, accent), 90f))
                g.FillRectangle(gb, glow);

            // okładka
            Rectangle cr = R(PAD, PAD, 56, 56);
            using (GraphicsPath cp = Round(cr, Sc(6)))
            {
                if (cover != null)
                {
                    GraphicsState st = g.Save();
                    g.SetClip(cp);
                    g.DrawImage(cover, cr);
                    g.Restore(st);
                }
                else
                {
                    using (LinearGradientBrush b = new LinearGradientBrush(cr, accent, Color.FromArgb(34, 34, 40), 45f)) g.FillPath(b, cp);
                    Txt(g, "\u266A", fGlyph, cr, Color.FromArgb(220, 255, 255, 255), TextFormatFlags.HorizontalCenter);
                }
            }

            // tytuł + wykonawca
            int tx = cr.Right + Sc(12);
            int tw = Width - tx - Sc(PAD);
            bool has = title.Length > 0;
            Txt(g, has ? title : L["nothing"], fTitle, new Rectangle(tx, Sc(PAD + 6), tw, Sc(22)), has ? TXT : MUTED, TextFormatFlags.Left);
            if (artist.Length > 0) Txt(g, artist, fArtist, new Rectangle(tx, Sc(PAD + 29), tw, Sc(18)), MUTED, TextFormatFlags.Left);

            // pasek postępu
            float bx = PAD, by = 84, bw = Width / S - PAD * 2;
            using (GraphicsPath bp = Round(new RectangleF(Sc(bx), Sc(by), Sc(bw), Sc(4)), Sc(2)))
            using (SolidBrush bb = new SolidBrush(Color.FromArgb(40, 255, 255, 255))) g.FillPath(bb, bp);
            if (dur > 0)
            {
                double p = CurPos();
                float fw = (float)(bw * Math.Min(1.0, p / dur));
                if (fw > 0.5f)
                    using (GraphicsPath fp = Round(new RectangleF(Sc(bx), Sc(by), Sc(fw), Sc(4)), Sc(2)))
                    using (SolidBrush fb = new SolidBrush(accent)) g.FillPath(fb, fp);
                Txt(g, Fmt(p), fSmall, R(bx, by + 7, 60, 14), MUTED, TextFormatFlags.Left);
                Txt(g, Fmt(dur), fSmall, R(bx + bw - 60, by + 7, 60, 14), MUTED, TextFormatFlags.Right);
            }

            // przyciski i wiersze
            for (int i = 0; i < items.Count; i++) DrawItem(g, items[i]);

            // separatory
            using (Pen sp = new Pen(Color.FromArgb(24, 255, 255, 255), Math.Max(1, Sc(1))))
            {
                g.DrawLine(sp, Sc(PAD), Sc(rowsTop - 6), Width - Sc(PAD), Sc(rowsTop - 6));
                float qy = rowsTop + ROW * 4 + 4;
                g.DrawLine(sp, Sc(PAD), Sc(qy), Width - Sc(PAD), Sc(qy));
            }
            // ramka (w Windows 11 rysuje ją też system — przy zaokrąglonych rogach)
            using (Pen bp2 = new Pen(Color.FromArgb(36, 255, 255, 255))) g.DrawRectangle(bp2, 0, 0, Width - 1, Height - 1);
        }

        void DrawItem(Graphics g, Item it)
        {
            bool isHot = it.Id == hot, isDown = it.Id == down;
            if (it.Kind == 0)
            {
                RectangleF r = it.R;
                bool main = it.Id == "toggle";
                Color ic;
                if (main)
                {
                    Color fill = !it.Enabled ? Color.FromArgb(90, 255, 255, 255) : (isHot ? accent : Color.White);
                    if (isDown) r.Inflate(-Sc(1.5f), -Sc(1.5f));
                    using (SolidBrush fb0 = new SolidBrush(fill)) g.FillEllipse(fb0, r);
                    ic = Color.FromArgb(12, 12, 16);
                }
                else
                {
                    if (isHot) { using (SolidBrush hb0 = new SolidBrush(Color.FromArgb(isDown ? 40 : 26, 255, 255, 255))) g.FillEllipse(hb0, r); }
                    ic = it.Enabled ? (isHot ? Color.White : Color.FromArgb(215, 215, 215)) : Color.FromArgb(80, 255, 255, 255);
                }
                float cx = r.X + r.Width / 2, cy = r.Y + r.Height / 2, s = Sc(main ? 8.5f : 7f);
                using (SolidBrush ib = new SolidBrush(ic))
                {
                    if (it.Id == "toggle")
                    {
                        if (playing)
                        {
                            float bw = s * 0.62f, gap = s * 0.42f;
                            using (GraphicsPath p1 = Round(new RectangleF(cx - gap - bw, cy - s, bw, s * 2), Sc(1)))
                            using (GraphicsPath p2 = Round(new RectangleF(cx + gap, cy - s, bw, s * 2), Sc(1)))
                            { g.FillPath(ib, p1); g.FillPath(ib, p2); }
                        }
                        else
                        {
                            g.FillPolygon(ib, new PointF[] { new PointF(cx - s * 0.6f, cy - s), new PointF(cx - s * 0.6f, cy + s), new PointF(cx + s * 0.95f, cy) });
                        }
                    }
                    else
                    {
                        float dir = it.Id == "next" ? 1 : -1;
                        float tipX = cx + dir * s * 0.55f, baseX = cx - dir * s * 0.75f;
                        g.FillPolygon(ib, new PointF[] { new PointF(baseX, cy - s * 0.85f), new PointF(baseX, cy + s * 0.85f), new PointF(tipX, cy) });
                        float barX = it.Id == "next" ? tipX : tipX - Sc(2.2f);
                        g.FillRectangle(ib, barX, cy - s * 0.85f, Sc(2.2f), s * 1.7f);
                    }
                }
                return;
            }

            // wiersze
            RectangleF rr = it.R;
            if (isHot)
            {
                Color hb = it.Kind == 3 ? Color.FromArgb(isDown ? 120 : 90, 215, 60, 60) : Color.FromArgb(isDown ? 34 : 22, 255, 255, 255);
                using (GraphicsPath hp = Round(rr, Sc(6)))
                using (SolidBrush hbr = new SolidBrush(hb)) g.FillPath(hbr, hp);
            }
            string label;
            bool on = false;
            switch (it.Id)
            {
                case "show": label = hidden ? L["show"] : L["hide"]; break;
                case "mini": label = L["mini"]; on = mini; break;
                case "ontop": label = L["ontop"]; on = onTop; break;
                case "closetray": label = L["closetray"]; on = closeToTray; break;
                default: label = L["quit"]; break;
            }
            Color tc = it.Kind == 3 && isHot ? Color.White : TXT;
            Rectangle tr = new Rectangle(it.R.X + Sc(12), it.R.Y, it.R.Width - Sc(60), it.R.Height);
            Txt(g, label, fRow, tr, tc, TextFormatFlags.Left);
            if (it.Kind == 2)
            {
                // przełącznik jak w ustawieniach Pulsara
                RectangleF sw = new RectangleF(it.R.Right - Sc(12 + 30), it.R.Y + (it.R.Height - Sc(16)) / 2f, Sc(30), Sc(16));
                using (GraphicsPath sp = Round(sw, sw.Height / 2))
                using (SolidBrush swb = new SolidBrush(on ? accent : Color.FromArgb(72, 72, 78))) g.FillPath(swb, sp);
                float k = sw.Height - Sc(4);
                float kx = on ? sw.Right - Sc(2) - k : sw.X + Sc(2);
                using (SolidBrush kb = new SolidBrush(on ? Color.White : Color.FromArgb(205, 205, 210)))
                    g.FillEllipse(kb, kx, sw.Y + Sc(2), k, k);
            }
        }
    }
}
