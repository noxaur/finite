import { useParams } from "react-router";

export default function User() {
  const { userId } = useParams();
  return <h1>User {userId}</h1>;
}
