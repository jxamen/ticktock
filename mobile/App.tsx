import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { LoginScreen } from "./src/screens/LoginScreen";
import { DevicesScreen } from "./src/screens/DevicesScreen";
import { PairingScreen } from "./src/screens/PairingScreen";
import { ControlScreen } from "./src/screens/ControlScreen";
import { ScheduleScreen } from "./src/screens/ScheduleScreen";
import { UsageScreen } from "./src/screens/UsageScreen";
import type { RootStackParamList } from "./src/navigation";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <NavigationContainer>
      <StatusBar style="auto" />
      <Stack.Navigator>
        <Stack.Screen name="Login" component={LoginScreen} options={{ title: "로그인" }} />
        <Stack.Screen name="Devices" component={DevicesScreen} options={{ title: "TickTock" }} />
        <Stack.Screen name="Pairing" component={PairingScreen} options={{ title: "PC 연결" }} />
        <Stack.Screen name="Control" component={ControlScreen} options={{ title: "제어" }} />
        <Stack.Screen name="Schedule" component={ScheduleScreen} options={{ title: "스케줄" }} />
        <Stack.Screen name="Usage" component={UsageScreen} options={{ title: "사용 시간" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
