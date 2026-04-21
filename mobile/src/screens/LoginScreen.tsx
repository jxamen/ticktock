import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert, ActivityIndicator } from "react-native";
import { onAuthStateChanged, signInWithEmailAndPassword } from "firebase/auth";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { auth } from "../firebase";
import type { RootStackParamList } from "../navigation";

type Props = NativeStackScreenProps<RootStackParamList, "Login">;

export function LoginScreen({ navigation }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Firebase persistence via AsyncStorage restores the user asynchronously, so
  // show a spinner until we know whether we can skip login.
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        navigation.replace("Devices");
      } else {
        setChecking(false);
      }
    });
    return unsub;
  }, [navigation]);

  const onLogin = async () => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
      // navigation happens via onAuthStateChanged.
    } catch (e) {
      Alert.alert("로그인 실패", String(e));
    }
  };

  if (checking) {
    return (
      <View style={[styles.root, { justifyContent: "center" }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>TickTock</Text>
      <TextInput style={styles.input} placeholder="이메일" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
      <TextInput style={styles.input} placeholder="비밀번호" secureTextEntry value={password} onChangeText={setPassword} />
      <Pressable style={styles.btn} onPress={onLogin}>
        <Text style={styles.btnText}>로그인</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, justifyContent: "center" },
  title: { fontSize: 36, fontWeight: "700", marginBottom: 32, textAlign: "center" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, marginBottom: 12 },
  btn: { backgroundColor: "#2563eb", padding: 14, borderRadius: 8, marginTop: 8 },
  btnText: { color: "white", textAlign: "center", fontWeight: "600", fontSize: 16 },
});
