package dev.karaoke.web;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Enumeration;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import jakarta.servlet.http.HttpServletRequest;

@RestController
@RequestMapping("/api/server-info")
public class ServerInfoController {

    /**
     * URL que convidados na LAN devem usar + se quem perguntou é o anfitrião.
     * O frontend usa isso para montar o QR code e para decidir se mostra
     * os botões de edição (menu ⋯, apagar, etc.).
     */
    @GetMapping
    public ServerInfo info(HttpServletRequest request) {
        String host = findLanIp();
        if (host == null) {
            host = request.getServerName();
        }
        String url = "http://" + host + ":" + request.getServerPort();
        return new ServerInfo(url, isLocal(request));
    }

    private static boolean isLocal(HttpServletRequest req) {
        String a = req.getRemoteAddr();
        return "127.0.0.1".equals(a) || "::1".equals(a) || "0:0:0:0:0:0:0:1".equals(a);
    }

    /** Primeiro IPv4 não-loopback/não-link-local de uma interface ativa. */
    private static String findLanIp() {
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces.hasMoreElements()) {
                NetworkInterface iface = ifaces.nextElement();
                if (!iface.isUp() || iface.isLoopback() || iface.isVirtual()) {
                    continue;
                }
                Enumeration<InetAddress> addrs = iface.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (addr instanceof Inet4Address
                            && !addr.isLoopbackAddress()
                            && !addr.isLinkLocalAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
            // sem rede? devolve null e o controller cai no request.getServerName()
        }
        return null;
    }

    public record ServerInfo(String url, boolean local) {}
}