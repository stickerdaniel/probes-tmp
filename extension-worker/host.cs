using System;
using System.Diagnostics;

static class Host
{
    static int Main()
    {
        var start = new ProcessStartInfo(
            Environment.GetEnvironmentVariable("PROBE_HOST_NODE"),
            "\"" + Environment.GetEnvironmentVariable("PROBE_HOST_SCRIPT") + "\"")
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            CreateNoWindow = true
        };
        using (var child = Process.Start(start))
        using (var input = Console.OpenStandardInput())
        {
            var output = child.StandardInput.BaseStream;
            var buffer = new byte[8192];
            int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                output.Write(buffer, 0, count);
                output.Flush();
            }
            child.StandardInput.Close();
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
