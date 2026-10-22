// ScreenLink input helper for Windows.
//
// A tiny console app that reads one command per line from stdin and injects
// the matching mouse/keyboard event. Keeping injection in its own process
// means the Electron app needs zero native Node modules, and the helper can
// be killed instantly to guarantee that remote control really stops.
//
//   MM <x> <y>            move the cursor to absolute physical pixels
//   MB <0|1> <left|right|middle>   mouse button down (0) / up (1)
//   MW <dy> <dx>          wheel (dy) and horizontal wheel (dx) deltas
//   KD <vk> / KU <vk>     key down / key up, Windows virtual-key code
//   CLIP <base64 utf8>    replace the clipboard contents
//   EXIT                  quit
//
// Build (Windows):
//   csc /nologo /optimize /target:exe /out:input-helper.exe ^
//       /r:System.Windows.Forms.dll input-helper.cs

using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class Program
{
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x01000;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    private static int Main()
    {
        // Without DPI awareness Windows would scale the coordinates we send.
        try
        {
            if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
                SetProcessDPIAware();
        }
        catch (Exception) { }

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;

            int space = line.IndexOf(' ');
            string cmd = space < 0 ? line : line.Substring(0, space);
            string rest = space < 0 ? string.Empty : line.Substring(space + 1).Trim();

            try
            {
                switch (cmd)
                {
                    case "EXIT":
                        return 0;
                    case "MM":
                        MoveMouse(rest);
                        break;
                    case "MB":
                        MouseButton(rest);
                        break;
                    case "MW":
                        Wheel(rest);
                        break;
                    case "KD":
                        Key(rest, true);
                        break;
                    case "KU":
                        Key(rest, false);
                        break;
                    case "CLIP":
                        SetClipboard(rest);
                        break;
                    default:
                        break; // ignore unknown commands
                }
            }
            catch (Exception)
            {
                // Never die on a bad command: a dropped pipe would leave the
                // user with a stuck button or modifier key.
            }
        }
        return 0;
    }

    private static void MoveMouse(string rest)
    {
        string[] parts = rest.Split(' ');
        if (parts.Length < 2) return;
        int x, y;
        if (!int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out x)) return;
        if (!int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out y)) return;
        SetCursorPos(x, y);
    }

    private static void MouseButton(string rest)
    {
        string[] parts = rest.Split(' ');
        if (parts.Length < 2) return;
        bool up = parts[0] == "1";
        uint flags;
        switch (parts[1])
        {
            case "right": flags = up ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_RIGHTDOWN; break;
            case "middle": flags = up ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_MIDDLEDOWN; break;
            default: flags = up ? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_LEFTDOWN; break;
        }
        mouse_event(flags, 0, 0, 0, UIntPtr.Zero);
    }

    private static void Wheel(string rest)
    {
        string[] parts = rest.Split(' ');
        if (parts.Length < 2) return;
        int dy, dx;
        int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out dy);
        int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out dx);
        if (dy != 0) mouse_event(MOUSEEVENTF_WHEEL, 0, 0, dy, UIntPtr.Zero);
        if (dx != 0) mouse_event(MOUSEEVENTF_HWHEEL, 0, 0, dx, UIntPtr.Zero);
    }

    private static bool IsExtendedKey(int vk)
    {
        switch (vk)
        {
            case 0x21: // page up
            case 0x22: // page down
            case 0x23: // end
            case 0x24: // home
            case 0x25: // left
            case 0x26: // up
            case 0x27: // right
            case 0x28: // down
            case 0x2C: // print screen
            case 0x2D: // insert
            case 0x2E: // delete
            case 0x5B: // left windows
            case 0x5C: // right windows
            case 0x5D: // menu
            case 0x6F: // numpad divide
            case 0x90: // num lock
            case 0xA3: // right control
            case 0xA5: // right alt
                return true;
            default:
                return false;
        }
    }

    private static void Key(string rest, bool down)
    {
        int vk;
        if (!int.TryParse(rest, NumberStyles.Integer, CultureInfo.InvariantCulture, out vk)) return;
        if (vk < 1 || vk > 255) return;
        uint flags = 0;
        if (down) flags |= 0; else flags |= KEYEVENTF_KEYUP;
        if (IsExtendedKey(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
        keybd_event((byte)vk, 0, flags, UIntPtr.Zero);
    }

    private static void SetClipboard(string rest)
    {
        string text;
        try
        {
            text = Encoding.UTF8.GetString(Convert.FromBase64String(rest));
        }
        catch (Exception)
        {
            return;
        }

        // The clipboard needs an STA thread, and stdin is not one.
        Thread t = new Thread(delegate ()
        {
            try { Clipboard.SetText(text); }
            catch (Exception) { }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.IsBackground = true;
        t.Start();
        t.Join(1500);
    }
}
