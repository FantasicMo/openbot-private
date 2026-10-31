import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.MessageDigest;

/**
 * Atomic text entry for one disposable emulator fixture, never the target application's code.
 * https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo#ACTION_SET_TEXT
 * https://android.googlesource.com/platform/frameworks/base/+/HEAD/core/java/android/app/UiAutomation.java
 */
public final class PrivateAndroidFixtureInput {
    private static final String PACKAGE = "io.github.fantasicmo.openbot";
    private static final String INPUT = "/data/local/tmp/openbot-private-fixture-input.txt";
    private static Class<?> nodeClass;
    private static Class<?> bundleClass;
    private static Object automation;
    private static String phase = "guard";
    private static String expected = "";
    private static String observed = "";
    private static boolean focused;
    private static boolean cleared;
    private static boolean exactMatch;
    private static boolean hashMatch;

    private static Object findField(Object node, int depth, int[] remaining) throws Exception {
        if (node == null || depth > 64 || --remaining[0] < 0) return null;
        String owner = String.valueOf(nodeClass.getMethod("getPackageName").invoke(node));
        String kind = String.valueOf(nodeClass.getMethod("getClassName").invoke(node));
        if (PACKAGE.equals(owner) && kind.endsWith("EditText")
                && Boolean.TRUE.equals(nodeClass.getMethod("isEditable").invoke(node))) {
            nodeClass.getMethod("refresh").invoke(node);
            return node;
        }
        int count = (Integer) nodeClass.getMethod("getChildCount").invoke(node);
        Method child = nodeClass.getMethod("getChild", int.class);
        for (int index = 0; index < count; index++) {
            Object found = findField(child.invoke(node, index), depth + 1, remaining);
            if (found != null) return found;
        }
        return null;
    }

    private static Object currentField() throws Exception {
        Object root = automation.getClass().getMethod("getRootInActiveWindow").invoke(automation);
        return findField(root, 0, new int[] {512});
    }

    private static String readText(Object field) throws Exception {
        focused = Boolean.TRUE.equals(nodeClass.getMethod("isFocused").invoke(field));
        if (Boolean.TRUE.equals(nodeClass.getMethod("isShowingHintText").invoke(field))) return "";
        Object text = nodeClass.getMethod("getText").invoke(field);
        return text == null ? "" : text.toString();
    }

    private static Object awaitField(String target, boolean requireFocus) throws Exception {
        long deadline = System.nanoTime() + 10_000_000_000L;
        while (System.nanoTime() < deadline) {
            Object field = currentField();
            if (field != null) {
                observed = readText(field);
                if ((target == null || target.equals(observed)) && (!requireFocus || focused)) return field;
            }
            Thread.sleep(50);
        }
        throw new IllegalStateException("Fixture input condition was not met.");
    }

    private static void setText(Object field, String text) throws Exception {
        Object arguments = bundleClass.getConstructor().newInstance();
        String key = (String) nodeClass.getField("ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE").get(null);
        bundleClass.getMethod("putCharSequence", String.class, CharSequence.class).invoke(arguments, key, text);
        int action = nodeClass.getField("ACTION_SET_TEXT").getInt(null);
        if (!Boolean.TRUE.equals(nodeClass.getMethod("performAction", int.class, bundleClass).invoke(field, action, arguments))) {
            throw new IllegalStateException("The fixture set-text action was refused.");
        }
    }

    public static void main(String[] args) {
        Object handlerThread = null;
        boolean connected = false;
        int result = 1;
        try {
            Class<?> properties = Class.forName("android.os.SystemProperties");
            if (args.length != 0
                    || !"1".equals(properties.getMethod("get", String.class).invoke(null, "ro.kernel.qemu"))
                    || !"36".equals(properties.getMethod("get", String.class).invoke(null, "ro.build.version.sdk"))
                    || !"openbot-private-smoke".equals(properties.getMethod("get", String.class).invoke(null, "ro.boot.qemu.avd_name"))
                    || ((Integer) Class.forName("android.os.Process").getMethod("myUid").invoke(null)) != 0) {
                throw new IllegalStateException("The fixture requires its disposable root emulator.");
            }
            phase = "input-file";
            if (Files.size(Paths.get(INPUT)) < 1 || Files.size(Paths.get(INPUT)) > 16_384) {
                throw new IllegalStateException("The fixture input file has an invalid length.");
            }
            expected = new String(Files.readAllBytes(Paths.get(INPUT)), StandardCharsets.UTF_8);
            if (!expected.startsWith("{") || expected.indexOf('\0') >= 0) {
                throw new IllegalStateException("The fixture input is not JSON text.");
            }
            phase = "automation";
            Class<?> handlerClass = Class.forName("android.os.HandlerThread");
            handlerThread = handlerClass.getConstructor(String.class).newInstance("OpenBotFixtureInput");
            ((Thread) handlerThread).start();
            Object looper = handlerClass.getMethod("getLooper").invoke(handlerThread);
            Object connection = Class.forName("android.app.UiAutomationConnection").getConstructor().newInstance();
            Class<?> automationClass = Class.forName("android.app.UiAutomation");
            automation = automationClass.getConstructor(Class.forName("android.os.Looper"), Class.forName("android.app.IUiAutomationConnection")).newInstance(looper, connection);
            int flags = automationClass.getField("FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES").getInt(null);
            automationClass.getMethod("connect", int.class).invoke(automation, flags);
            connected = true;
            nodeClass = Class.forName("android.view.accessibility.AccessibilityNodeInfo");
            bundleClass = Class.forName("android.os.Bundle");
            phase = "focus";
            Object field = awaitField(null, false);
            nodeClass.getMethod("performAction", int.class).invoke(field, nodeClass.getField("ACTION_FOCUS").getInt(null));
            field = awaitField(null, true);
            phase = "clear";
            setText(field, "");
            field = awaitField("", true);
            cleared = true;
            phase = "set";
            setText(field, expected);
            phase = "confirm";
            awaitField(expected, true);
            exactMatch = expected.equals(observed);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            hashMatch = MessageDigest.isEqual(digest.digest(expected.getBytes(StandardCharsets.UTF_8)), digest.digest(observed.getBytes(StandardCharsets.UTF_8)));
            if (!exactMatch || !hashMatch) throw new IllegalStateException("The fixture input differs.");
            result = 0;
        } catch (Throwable ignored) {
            // No exception text, input, URL or credential leaves this helper.
        } finally {
            if (connected) {
                try { automation.getClass().getMethod("disconnect").invoke(automation); } catch (Throwable ignored) { }
            }
            if (handlerThread != null) {
                try {
                    handlerThread.getClass().getMethod("quitSafely").invoke(handlerThread);
                    ((Thread) handlerThread).join(2_000);
                } catch (Throwable ignored) { }
            }
            System.out.println("{\"status\":\"" + (result == 0 ? "set" : "failed") + "\",\"stage\":\"" + phase
                    + "\",\"expectedCharacters\":" + expected.length() + ",\"observedCharacters\":" + observed.length()
                    + ",\"focused\":" + focused + ",\"cleared\":" + cleared + ",\"exactMatch\":" + exactMatch + ",\"hashMatch\":" + hashMatch + "}");
            System.exit(result);
        }
    }
}
